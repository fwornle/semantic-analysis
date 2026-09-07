/**
 * Tests for parseLlmJson — the repair that keeps a component's whole analysis
 * from being discarded over an unescaped newline.
 *
 * Runner: node --test dist/utils/parse-llm-json.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseLlmJson, escapeControlCharsInStrings } from './parse-llm-json.js';

describe('parseLlmJson', () => {
  it('parses a clean reply without claiming a repair', () => {
    const r = parseLlmJson<{ summary: string }>('{"summary":"fine"}');
    assert.equal(r.value?.summary, 'fine');
    assert.equal(r.repaired, false);
  });

  it('strips a ```json fence', () => {
    const r = parseLlmJson<{ a: number }>('```json\n{"a":1}\n```');
    assert.equal(r.value?.a, 1);
    assert.equal(r.repaired, false);
  });

  it('repairs the failure seen in production: a raw newline inside a string', () => {
    // Shape of the 2026-09-07 wave-1 replies, which threw
    // "Bad control character in string literal in JSON at position 908".
    const raw =
      '{\n  "summary": "LiveLoggingSystem (LSL) is the live session-logging\ninfrastructure.",\n  "observations": ["one", "two"]\n}';
    assert.throws(() => JSON.parse(raw), /control character/i);

    const r = parseLlmJson<{ summary: string; observations: string[] }>(raw);
    assert.equal(r.repaired, true);
    assert.match(r.value!.summary, /live session-logging\ninfrastructure/);
    assert.deepEqual(r.value!.observations, ['one', 'two']);
  });

  it('repairs tabs and other control characters too', () => {
    const r = parseLlmJson<{ a: string }>('{"a":"x\tyz"}');
    assert.equal(r.repaired, true);
    assert.equal(r.value?.a, 'x\tyz');
  });

  it('leaves the newlines BETWEEN tokens alone', () => {
    // Pretty-printed JSON is full of control characters outside strings;
    // escaping those would corrupt a reply that parsed perfectly well.
    const pretty = '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}';
    assert.equal(escapeControlCharsInStrings(pretty), pretty);
  });

  it('does not mistake an escaped quote for the end of a string', () => {
    const raw = '{"a":"he said \\"hi\\"\nthen left"}';
    const r = parseLlmJson<{ a: string }>(raw);
    assert.equal(r.repaired, true);
    assert.equal(r.value?.a, 'he said "hi"\nthen left');
  });

  it('does not mistake an escaped backslash for an escape', () => {
    const raw = '{"a":"ends with a backslash \\\\"}';
    const r = parseLlmJson<{ a: string }>(raw);
    assert.equal(r.repaired, false);
    assert.equal(r.value?.a, 'ends with a backslash \\');
  });

  it('still fails on a reply that is malformed some other way', () => {
    // The repair must not become a general-purpose JSON guesser: a truncated
    // reply is a real failure and the caller needs to see it.
    const r = parseLlmJson('{"a": [1, 2');
    assert.equal(r.value, null);
    assert.ok(r.error && r.error.length > 0);
  });

  it('reports the error the model actually caused, not the repair artefact', () => {
    const r = parseLlmJson('not json at all');
    assert.equal(r.value, null);
    assert.match(r.error!, /JSON/i);
  });
});
