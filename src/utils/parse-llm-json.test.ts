/**
 * Tests for parseLlmJson — the repair that keeps a component's whole analysis
 * from being discarded over an unescaped newline.
 *
 * Runner: node --test dist/utils/parse-llm-json.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLlmJson,
  escapeControlCharsInStrings,
  truncateToLastCompleteElement,
} from './parse-llm-json.js';

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
    // reply is a real failure and a caller that did not opt into salvage
    // needs to see it.
    const r = parseLlmJson('{"a": [1, 2');
    assert.equal(r.value, null);
    assert.equal(r.truncated, false);
    assert.ok(r.error && r.error.length > 0);
  });

  it('reports the error the model actually caused, not the repair artefact', () => {
    const r = parseLlmJson('not json at all');
    assert.equal(r.value, null);
    assert.match(r.error!, /JSON/i);
  });
});

describe('truncation salvage', () => {
  // The shape wave-2 asks for. Truncating this mid-string is exactly what the
  // 4096-token ceiling did on 2026-09-20.
  const complete = JSON.stringify({
    subComponents: [
      { name: 'Alpha', description: 'first', observations: ['a1'], suggestedL3Children: [] },
      { name: 'Beta', description: 'second', observations: ['b1'], suggestedL3Children: [] },
      { name: 'Gamma', description: 'third', observations: ['c1'], suggestedL3Children: [] },
    ],
  });

  /** Cut the document mid-way through the LAST element's description string. */
  const cutMidString = complete.slice(0, complete.indexOf('"third"') + 4);

  it('is OFF by default — a truncated reply still fails loudly', () => {
    const r = parseLlmJson(cutMidString);
    assert.equal(r.value, null);
    assert.equal(r.truncated, false);
    assert.match(r.error!, /Unterminated string|JSON/i);
  });

  it('recovers every complete element and drops the fragment when asked', () => {
    const r = parseLlmJson<{ subComponents: Array<{ name: string }> }>(
      cutMidString,
      { salvageTruncated: true },
    );
    assert.equal(r.truncated, true);
    // Alpha and Beta were whole; Gamma was half-written and must not appear.
    assert.deepEqual(r.value!.subComponents.map(c => c.name), ['Alpha', 'Beta']);
  });

  it('does not claim truncation when the reply was in fact complete', () => {
    const r = parseLlmJson<{ subComponents: unknown[] }>(complete, { salvageTruncated: true });
    assert.equal(r.truncated, false);
    assert.equal(r.repaired, false);
    assert.equal(r.value!.subComponents.length, 3);
  });

  it('handles a cut that lands between elements, not inside one', () => {
    const betweenElements = complete.slice(0, complete.indexOf('{"name":"Gamma"'));
    const r = parseLlmJson<{ subComponents: Array<{ name: string }> }>(
      betweenElements,
      { salvageTruncated: true },
    );
    assert.equal(r.truncated, true);
    assert.deepEqual(r.value!.subComponents.map(c => c.name), ['Alpha', 'Beta']);
  });

  it('salvages a reply that is BOTH truncated and control-character dirty', () => {
    // Both failures in one reply: a raw newline in an early string, and a cut
    // in the last one. The salvage runs on the escaped text, so both are
    // handled in a single pass.
    const dirty =
      '{"subComponents":[{"name":"Alpha","description":"line one\nline two"},{"name":"Beta","descr';
    const r = parseLlmJson<{ subComponents: Array<{ name: string; description: string }> }>(
      dirty,
      { salvageTruncated: true },
    );
    assert.equal(r.truncated, true);
    assert.deepEqual(r.value!.subComponents.map(c => c.name), ['Alpha']);
    assert.match(r.value!.subComponents[0].description, /line one\nline two/);
  });

  it('refuses to salvage a reply cut before any element completed', () => {
    // Nothing whole survived the cut. Inventing a value here would be the
    // silent reinterpretation the module exists to avoid.
    const r = parseLlmJson('{"subComponents":[{"name":"Alp', { salvageTruncated: true });
    assert.equal(r.value, null);
    assert.equal(r.truncated, false);
  });

  it('does not treat a brace inside a string as a structural close', () => {
    const raw = '{"items":[{"text":"a } b ] c"},{"text":"unterminated';
    const salvaged = truncateToLastCompleteElement(raw);
    assert.ok(salvaged !== null);
    const parsed = JSON.parse(salvaged!) as { items: Array<{ text: string }> };
    assert.deepEqual(parsed.items.map(i => i.text), ['a } b ] c']);
  });

  it('returns null for a document with no nested structure to cut back to', () => {
    assert.equal(truncateToLastCompleteElement('{"a": "unterminated'), null);
  });
});
