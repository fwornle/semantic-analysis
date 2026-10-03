/**
 * The proxy client that replaced the vendored `@rapid/llm-proxy` SDK.
 *
 * Every LLM call semantic-analysis makes now goes to the daemon's
 * `/api/complete`, which routes on `body.process`. Three things the SDK used
 * to do implicitly must keep holding:
 *
 *  1. Every call carries a `process` tag — an untagged call is routed by
 *     `defaults.background` and lands in token-usage as `process='unknown'`.
 *  2. Each call is recorded in the agent's metrics tracker, which
 *     wave-controller turns into the workflow trace.
 *  3. Mock mode (`ukb debug`) never dials out. Before the migration the mock
 *     path depended on SDK provider wiring, and two separate bugs made debug
 *     runs make real, metered calls while logging "intended=mock".
 *
 * A local HTTP server stands in for the daemon and records each request body.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { llmWithProcessComplete, createLLMWithProcess, LLMMetricsTracker } from './llm-with-process.js';
import { SemanticAnalyzer } from './semantic-analyzer.js';

const bodies: Array<Record<string, unknown>> = [];
let status = 200;
let server: http.Server;
let codingRoot: string;

function setLLMMode(mode: 'mock' | 'public'): void {
  writeFileSync(
    join(codingRoot, '.data', 'workflow-progress.json'),
    JSON.stringify({ llmState: { globalMode: mode }, mockLLMDelay: 0 }),
  );
}

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(status === 200
        ? JSON.stringify({ content: 'ok', provider: 'gh-copilot', model: 'claude-haiku-4.5', tokens: { input: 7, output: 3, total: 10 }, latencyMs: 5 })
        : JSON.stringify({ error: 'boom' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.RAPID_LLM_PROXY_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  codingRoot = mkdtempSync(join(tmpdir(), 'llm-with-process-'));
  mkdirSync(join(codingRoot, '.data'));
  process.env.CODING_ROOT = codingRoot;
});

after(() => {
  server.close();
  rmSync(codingRoot, { recursive: true, force: true });
});

describe('llmWithProcessComplete', () => {
  test('sends the process tag and maps the reply into the SDK shape', async () => {
    bodies.length = 0;
    status = 200;
    const res = await llmWithProcessComplete({
      process: 'wave-analysis-staleness',
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 1000,
    });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].process, 'wave-analysis-staleness');
    assert.equal(bodies[0].maxTokens, 1000);
    assert.deepEqual(res.tokens, { input: 7, output: 3, total: 10 });
    assert.equal(res.provider, 'gh-copilot');
  });

  test('records each call, with previews, into the tracker', async () => {
    status = 200;
    const tracker = new LLMMetricsTracker();
    const llm = createLLMWithProcess('wave-analysis-wave1', tracker);
    await llm.complete({ messages: [{ role: 'user', content: 'prompt text' }], taskType: 'enrich' });
    const [call] = tracker.getCalls();
    assert.equal(tracker.getCalls().length, 1);
    assert.equal(call.provider, 'gh-copilot');
    assert.equal(call.totalTokens, 10);
    assert.equal(call.operationType, 'enrich');
    assert.equal(call.promptPreview, 'prompt text');
    assert.equal(call.responsePreview, 'ok');
  });

  test('throws on a non-2xx reply', async () => {
    status = 502;
    await assert.rejects(
      llmWithProcessComplete({ process: 'x', messages: [{ role: 'user', content: 'hi' }] }),
      /HTTP 502/,
    );
    status = 200;
  });
});

describe('SemanticAnalyzer', () => {
  test('mock mode answers from the mock service and never dials the proxy', async () => {
    bodies.length = 0;
    setLLMMode('mock');
    const analyzer = new SemanticAnalyzer();
    for (const opts of [{ process: 'wave-analysis-wave4-insight' }, {}]) {
      const res = await analyzer.analyzeContent('some content', { analysisType: 'raw', ...opts });
      assert.equal(res.provider, 'mock');
    }
    assert.equal(bodies.length, 0);
  });

  test('a call without a process tag is sent as wave-analysis-sem-analyzer', async () => {
    bodies.length = 0;
    setLLMMode('public');
    const analyzer = new SemanticAnalyzer();
    const res = await analyzer.analyzeContent('some content', { analysisType: 'raw' });
    assert.equal(res.provider, 'gh-copilot');
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].process, 'wave-analysis-sem-analyzer');
  });

  test("a caller's process tag is sent verbatim", async () => {
    bodies.length = 0;
    setLLMMode('public');
    await new SemanticAnalyzer().analyzeContent('x', { analysisType: 'raw', process: 'wave-analysis-wave4-docs' });
    assert.equal(bodies[0].process, 'wave-analysis-wave4-docs');
  });
});
