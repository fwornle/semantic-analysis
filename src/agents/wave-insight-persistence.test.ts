/**
 * Wave 4 insight persistence + duplicate-name anchoring — regression tests.
 *
 * Two failures, both silent, both found on 2026-09-20:
 *
 *  1. Wave 4 wrote 73 insight DOCUMENTS and zero Insight NODES. The graph held
 *     1021 `wave-analysis` entities and not one was an Insight, while all 900
 *     Insight nodes came from the online path — so the viewer's History
 *     sidebar (which filters to `Insight`) could never show a Batch badge, and
 *     nothing could ask the graph what a UKB run concluded.
 *
 *  2. The anchor pass resolved entities BY NAME ONLY. `findEntityByName` is
 *     "oldest wins", so a new `Detail` named EntityPatternAnalyzer inherited
 *     the 24 incoming edges of a Sep-7 `SubComponent` of the same name, was
 *     marked already-anchored, and stayed in the graph with no edges at all.
 *     Every batch that run logged `added=0 skipped=N` — doing nothing, and
 *     looking like it had done its job.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// These assert on source-level intent, so they read from src/ even though the
// test itself runs from dist/ — matching readSrcFile() in
// wave-controller-canonical-emit.test.ts. dist/agents/<this>.js → submodule
// root is two directories up.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const controller = readFileSync(join(root, 'src', 'agents', 'wave-controller.ts'), 'utf8');
const adapter = readFileSync(join(root, 'src', 'storage', 'km-core-adapter.ts'), 'utf8');

/** Minimal stand-in for the store's name scan, with the real "oldest wins" rule. */
function findEntityByName(
  rows: Array<{ id: string; name: string; entityType: string; createdAt: string }>,
  name: string,
  entityType?: string,
) {
  let best: typeof rows[number] | undefined;
  let bestTypeMatch = false;
  for (const e of rows) {
    if (e.name !== name) continue;
    const typeMatch = entityType === undefined || e.entityType === entityType;
    if (best === undefined) { best = e; bestTypeMatch = typeMatch; continue; }
    if (typeMatch && !bestTypeMatch) { best = e; bestTypeMatch = true; }
    else if (typeMatch === bestTypeMatch && e.createdAt < best.createdAt) best = e;
  }
  if (entityType !== undefined && best !== undefined && !bestTypeMatch) return undefined;
  return best;
}

// The exact graph state that produced the orphan.
const ROWS = [
  { id: 'old-1', name: 'EntityPatternAnalyzer', entityType: 'SubComponent', createdAt: '2026-09-07T17:24:14' },
  { id: 'old-2', name: 'EntityPatternAnalyzer', entityType: 'SubComponent', createdAt: '2026-09-07T17:40:16' },
  { id: 'old-3', name: 'EntityPatternAnalyzer', entityType: 'SubComponent', createdAt: '2026-09-07T17:46:58' },
  { id: 'new-detail', name: 'EntityPatternAnalyzer', entityType: 'Detail', createdAt: '2026-09-20T07:25:04' },
];

describe('duplicate-name resolution', () => {
  test('without a type it binds to the OLDEST namesake — the original bug', () => {
    const hit = findEntityByName(ROWS, 'EntityPatternAnalyzer');
    assert.equal(hit?.id, 'old-1');
    assert.equal(hit?.entityType, 'SubComponent', 'this is why the new Detail looked anchored');
  });

  test('with the type it binds to the entity the caller actually meant', () => {
    const hit = findEntityByName(ROWS, 'EntityPatternAnalyzer', 'Detail');
    assert.equal(hit?.id, 'new-detail');
  });

  test('a name owned only by another type resolves to nothing, not to that type', () => {
    const hit = findEntityByName(ROWS, 'EntityPatternAnalyzer', 'Insight');
    assert.equal(hit, undefined, 'must not bind an Insight edge onto a SubComponent');
  });
});

describe('km-core adapter threads the type through', () => {
  test('queryIncomingRelations accepts and forwards entityType', () => {
    assert.match(adapter, /queryIncomingRelations\(\s*toName: string,\s*entityType\?: string,?\s*\)/);
    assert.match(adapter, /findEntityByName\(toName, entityType\)/);
  });

  test('storeRelationship can disambiguate both endpoints', () => {
    assert.match(adapter, /endpointTypes\?: \{ from\?: string; to\?: string \}/);
    assert.match(adapter, /findEntityByName\(fromName, endpointTypes\?\.from\)/);
    assert.match(adapter, /findEntityByName\(toName, endpointTypes\?\.to\)/);
  });
});

describe('anchor pass', () => {
  test('detects using the entity type, not the bare name', () => {
    assert.match(controller, /queryIncomingRelations\(e\.name, e\.entityType\)/);
  });

  test('writes the contains edge bound to the intended node', () => {
    const idx = controller.indexOf("'contains',");
    assert.ok(idx > 0);
    assert.match(controller.slice(idx, idx + 400), /\{ to: e\.entityType \}/);
  });

  test('falls back to the project anchor instead of leaving an orphan', () => {
    assert.match(controller, /findBestParent\(e\.name, entities\) \?\? this\.projectAnchorName/);
    assert.match(controller, /private readonly projectAnchorName = 'Coding'/);
  });
});

describe('wave 4 persists insights as graph entities', () => {
  test('creates an Insight entity stamped as batch-learned', () => {
    assert.match(controller, /entityType: 'Insight'/);
    // learning-source.ts reads `source`, falling back to `subsystem`; both are
    // stamped so neither resolution path badges it Auto.
    const idx = controller.indexOf("entityType: 'Insight'");
    const block = controller.slice(idx, idx + 1200);
    assert.match(block, /source: 'wave-analysis'/);
    assert.match(block, /subsystem: 'wave-analysis'/);
  });

  test('anchors it with has_insight so it cannot land as an orphan', () => {
    assert.match(controller, /'has_insight'/);
    const idx = controller.indexOf("'has_insight'");
    assert.match(controller.slice(idx, idx + 500), /\{ from: entity\.type, to: 'Insight' \}/);
  });

  test('the Insight node is NOT named after its source entity', () => {
    // Reusing entity.name would recreate the very duplicate-name collision
    // that the anchor-pass fix above exists to survive.
    assert.match(controller, /const insightName = `\$\{entity\.name\} — Insight`/);
  });

  test('document count and entity count are reported separately', () => {
    assert.match(controller, /insightEntitiesStored/);
    assert.match(controller, /insightEntityErrors/);
    // A run that writes documents but no nodes must not read as clean.
    assert.match(controller, /generated > 0 && insightEntitiesStored === 0/);
  });
});
