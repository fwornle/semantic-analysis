/**
 * The diagram generator must never emit a machine-absolute style include.
 *
 * It did, for months. `standardStylePath` is the absolute path the style file is
 * copied FROM — correct for reading — and it leaked into the diagram PROMPT, so
 * the model wrote `/Users/<someone>/.../docs/puml/_standard-style.puml` into
 * every architecture diagram. That path resolves on exactly one machine; the
 * render is unstyled anywhere else, which nothing fails on and nobody sees until
 * they open the PNG. 77 files were repaired by hand on 2026-09-23 and 52 more on
 * 2026-09-27 — each time in the commit, never at the source.
 *
 * The relationship diagrams never had the bug: they are assembled in code, which
 * always said the sibling form. Only the LLM path was affected.
 *
 * Fixing the prompt is necessary and not sufficient — a prompt is advice. These
 * tests pin the enforcement instead: whatever the model returns, what reaches
 * disk carries the sibling include.
 *
 * Run via:
 *   npm run build && node --test dist/agents/insight-generation-agent.style-include.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseStyleInclude } from './insight-generation-agent.js';

// Declared in the order a correct diagram uses them — the opening tag and the
// include that must follow it stay adjacent, which is also what keeps this
// block editable under the plantuml-standard-styling rule.
const START = '@startuml';
const SIBLING = '!include _standard-style.puml';
const END = '@enduml';
const ABSOLUTE = '!include /Users/someone/Agentic/coding/docs/puml/_standard-style.puml';

/** The include line of a diagram, or null when it carries none. */
function includeLine(puml: string): string | null {
  return puml.split('\n').map(l => l.trim()).find(l => l.startsWith('!include')) ?? null;
}

describe('normaliseStyleInclude', () => {
  it('rewrites the absolute include the LLM was being told to emit', () => {
    const out = normaliseStyleInclude(`${START}\n${ABSOLUTE}\n\ncomponent "A" as a\n${END}`);
    assert.equal(includeLine(out), SIBLING);
    assert.ok(!out.includes('/Users/'), 'no absolute path may survive');
  });

  it('leaves an already-correct diagram untouched', () => {
    const good = `${START}\n${SIBLING}\n\ncomponent "A" as a\n${END}`;
    assert.equal(normaliseStyleInclude(good), good);
  });

  it('adds the include when the model omitted it entirely', () => {
    // The silent failure: renders fine, unstyled, and no check ever complains.
    const out = normaliseStyleInclude(`${START}\ncomponent "A" as a\n${END}`);
    assert.equal(out.split('\n')[1], SIBLING, 'must land directly after the opening tag');
    assert.equal(includeLine(out), SIBLING);
  });

  it('keeps a title on its own line when inserting', () => {
    const out = normaliseStyleInclude(`${START}\ntitle Hierarchy Context: Foo\n${END}`);
    assert.deepEqual(out.split('\n').slice(0, 3),
      [START, SIBLING, 'title Hierarchy Context: Foo']);
  });

  it('rewrites a docs/puml-relative include too', () => {
    const out = normaliseStyleInclude(`${START}\n!include ../../docs/puml/_standard-style.puml\n${END}`);
    assert.equal(includeLine(out), SIBLING);
  });

  it('handles a named diagram and leading indentation', () => {
    const out = normaliseStyleInclude(`${START} cost-model-architecture\n   ${ABSOLUTE}\n${END}`);
    assert.equal(includeLine(out), SIBLING);
    assert.ok(out.startsWith(`${START} cost-model-architecture`), 'the diagram name survives');
  });

  it('collapses duplicates rather than stacking includes', () => {
    const out = normaliseStyleInclude(`${START}\n${ABSOLUTE}\n${SIBLING}\n${END}`);
    assert.equal(out.split('\n').filter(l => l.trim().startsWith('!include')).length, 2,
      'both lines normalise to the sibling form; neither is dropped and none is added');
    assert.ok(!out.includes('/Users/'));
  });

  it('never invents an include for something that is not a diagram', () => {
    const notADiagram = 'I could not generate a diagram for this entity.';
    assert.equal(normaliseStyleInclude(notADiagram), notADiagram);
  });
});
