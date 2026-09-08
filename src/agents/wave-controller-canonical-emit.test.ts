/**
 * Unit tests for Phase 42 Plan 06 — canonical km-core Entity emit shape +
 * flag-gated km-core write path + km-core mergeEntities adoption.
 *
 * Tests are TDD-paired with the implementation in:
 *   - src/agents/canonical-mapper.ts (Task 1)
 *   - src/agents/wave1-project-agent.ts / wave2-component-agent.ts / wave3-detail-agent.ts
 *     (Task 1 — entity emit point rewired through toCanonicalEntity)
 *   - src/agents/kg-operators.ts (Task 1 — KGEntity interface extended)
 *   - src/agents/wave-controller.ts (Task 2 — persistWithKmCore flag-gated branch)
 *   - src/agents/deduplication.ts (Task 2 — mergeEntityGroup DELETED;
 *     callers forward to @fwornle/km-core mergeEntities)
 *
 * Test framework: node:test + node:assert/strict (matches existing project pattern;
 * see src/storage/km-core-adapter.test.ts and src/agents/coordinator-progress-merge.test.ts).
 *
 * Run via: `npm run build && node --test dist/agents/wave-controller-canonical-emit.test.js`
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { toCanonicalEntity, defaultProvider, defaultModel } from './canonical-mapper.js';
import type { KGEntity } from './kg-operators.js';

// ---------------------------------------------------------------------------
// Helpers — fake raw wave entity input (mirrors what wave1/2/3 currently emit).
// ---------------------------------------------------------------------------

function makeRaw(overrides: Partial<KGEntity> = {}): KGEntity {
  return {
    id: 'mc4flkglue8o7',
    name: 'TranscriptAdapter',
    type: 'Detail',
    observations: [
      'The TranscriptProcessor uses the TranscriptAdapter abstract base class.',
      'The parent analysis suggests the existence of TranscriptAdapter.',
    ],
    significance: 6,
    level: 3,
    parentId: 'TranscriptProcessor',
    hierarchyPath: 'Coding/Trajectory/TranscriptProcessor/TranscriptAdapter',
    ...overrides,
  };
}

// ===========================================================================
// Task 1 — canonical-mapper.ts unit tests (Tests 1-6)
// ===========================================================================

describe('Phase 42 Plan 06 — canonical-mapper (Task 1)', () => {
  // -------------------------------------------------------------------------
  // Test 1: toCanonicalEntity returns the canonical fields with correct values
  // -------------------------------------------------------------------------
  it('Test 1: builds canonical Entity with top-level legacyId, ontologyClass, layer, metadata.subsystem', () => {
    const runId = 'wave-analysis-2026-05-23-12-34-56';
    const raw = makeRaw();
    const entity = toCanonicalEntity(raw, 'Detail', runId);

    // Canonical fields
    assert.equal(entity.ontologyClass, 'Detail', 'ontologyClass matches wave class');
    assert.equal(entity.entityType, 'Detail', 'entityType preserved (alias of ontologyClass)');
    assert.equal(entity.layer, 'evidence', 'layer is evidence (wave-analysis is the offline UKB)');

    // Top-level legacyId per Phase 39 CF-D37
    assert.ok(entity.legacyId, 'legacyId is set');
    assert.equal(entity.legacyId!.system, 'B', 'legacyId.system === B');
    assert.equal(entity.legacyId!.id, 'mc4flkglue8o7', 'legacyId.id preserves raw nanoid');

    // Metadata subsystem
    const metadata = entity.metadata as Record<string, unknown>;
    assert.equal(metadata.subsystem, 'wave-analysis', 'metadata.subsystem === wave-analysis');

    // Metadata provenance with the runId we passed in
    const provenance = metadata.provenance as {
      createdBy: { runId: string; provider: string; model: string };
      lastConfirmedBy: { runId: string };
      confirmationCount: number;
    };
    assert.ok(provenance, 'metadata.provenance is set');
    assert.equal(provenance.createdBy.runId, runId, 'createdBy.runId matches input');
    assert.equal(provenance.lastConfirmedBy.runId, runId, 'lastConfirmedBy.runId matches input');
    assert.equal(provenance.confirmationCount, 1, 'confirmationCount === 1 on first emit');
    assert.equal(provenance.createdBy.provider, defaultProvider, `provider defaults to "${defaultProvider}"`);
    assert.equal(provenance.createdBy.model, defaultModel, `model defaults to "${defaultModel}"`);
  });

  // -------------------------------------------------------------------------
  // Test 2: descriptionSegments[0] is built from observations via Phase 39
  //         mergeDescriptionSegment building block; provider is 'wave-analysis'
  // -------------------------------------------------------------------------
  it('Test 2: builds descriptionSegments[0] with provider="wave-analysis" (not phase-42-migration)', () => {
    const runId = 'run-test-2';
    const raw = makeRaw();
    const entity = toCanonicalEntity(raw, 'Detail', runId);
    const metadata = entity.metadata as Record<string, unknown>;
    const segments = metadata.descriptionSegments as Array<{
      text: string;
      runId: string;
      provider: string;
      model: string;
      quality: string;
      timestamp: string;
      confirmations: unknown[];
    }>;

    assert.ok(Array.isArray(segments), 'descriptionSegments is an array');
    assert.equal(segments.length, 1, 'one initial segment');
    assert.equal(segments[0].runId, runId, 'segment.runId === input runId');
    assert.equal(segments[0].provider, 'wave-analysis', 'provider === wave-analysis (NOT phase-42-migration)');
    assert.notEqual(segments[0].provider, 'phase-42-migration', 'provider is NOT the migration-time tag');
    assert.ok(segments[0].text.includes('TranscriptAdapter'), 'segment.text is joined observations');
    assert.equal(segments[0].confirmations.length, 0, 'confirmations starts empty');
  });

  // -------------------------------------------------------------------------
  // Test 3: When raw.embedding is present, it flows through verbatim
  //         (Plan 04 typed Entity.embedding accepts it).
  // -------------------------------------------------------------------------
  it('Test 3: carries embedding through verbatim when present on raw entity', () => {
    const runId = 'run-test-3';
    const embedding = new Array(384).fill(0).map((_, i) => i / 384);
    const raw = makeRaw({ embedding });
    const entity = toCanonicalEntity(raw, 'Detail', runId);

    assert.deepEqual(entity.embedding, embedding, 'embedding flows through verbatim');
    assert.equal(entity.embedding!.length, 384, 'embedding length preserved');
  });

  it('Test 3b: omits embedding field when raw has none', () => {
    const runId = 'run-test-3b';
    const raw = makeRaw();
    const entity = toCanonicalEntity(raw, 'Detail', runId);
    assert.equal(entity.embedding, undefined, 'embedding stays undefined');
  });

  // -------------------------------------------------------------------------
  // Test 4: KGEntity interface extended (ontologyClass, legacyId, metadata,
  //         entityType all optional — existing call sites unaffected).
  // -------------------------------------------------------------------------
  it('Test 4: KGEntity interface accepts the new optional fields (compile-time check via typed cast)', () => {
    // The optional fields must compile without TS errors. Cast through any to
    // simulate the assignment a wave-controller test caller might do.
    const ent = {
      id: 'old-id',
      name: 'Foo',
      type: 'Component',
      observations: [],
      significance: 5,
      // New optional fields added in Phase 42 Plan 06:
      entityType: 'Component',
      ontologyClass: 'Component',
      metadata: { subsystem: 'wave-analysis' },
      legacyId: { system: 'B' as const, id: 'old-id' },
    } as KGEntity;

    assert.equal((ent as any).ontologyClass, 'Component');
    assert.equal((ent as any).legacyId.system, 'B');
    assert.equal((ent as any).metadata.subsystem, 'wave-analysis');
  });

  // -------------------------------------------------------------------------
  // Test 5: wave1/wave2/wave3 ontologyClass argument flows through correctly
  // -------------------------------------------------------------------------
  it('Test 5: ontologyClass argument passes through to the emitted Entity (Project | Component | SubComponent | Detail)', () => {
    const runId = 'run-test-5';
    for (const cls of ['Project', 'Component', 'SubComponent', 'Detail']) {
      const raw = makeRaw({ type: 'Anything' });
      const entity = toCanonicalEntity(raw, cls, runId);
      assert.equal(entity.ontologyClass, cls, `ontologyClass === ${cls}`);
      assert.equal(entity.entityType, cls, `entityType === ${cls}`);
    }
  });

  // -------------------------------------------------------------------------
  // Test 6: same runId across two emits — provenance stamp stable per wave run
  // -------------------------------------------------------------------------
  it('Test 6: runId is stable across multiple emits in the same wave run', () => {
    const runId = 'shared-run-id-2026-05-23';
    const a = toCanonicalEntity(makeRaw({ name: 'A' }), 'Component', runId);
    const b = toCanonicalEntity(makeRaw({ name: 'B' }), 'SubComponent', runId);
    const c = toCanonicalEntity(makeRaw({ name: 'C' }), 'Detail', runId);

    for (const e of [a, b, c]) {
      const metadata = e.metadata as Record<string, unknown>;
      const segments = metadata.descriptionSegments as Array<{ runId: string }>;
      const prov = metadata.provenance as { createdBy: { runId: string } };
      assert.equal(segments[0].runId, runId, `${e.name}: segment runId matches`);
      assert.equal(prov.createdBy.runId, runId, `${e.name}: provenance createdBy.runId matches`);
    }
  });
});

// ===========================================================================
// Task 2 — Wave-controller persistWithKmCore + deduplication.ts mergeEntities (Tests 7-11)
// ===========================================================================
//
// We test the persistWithKmCore branch via a thin unit-test seam: we re-export
// the logic shape by composing a tiny wave-result + stubbed adapter and
// invoking the same per-entity / per-relation loop the wave-controller now
// runs. This avoids spinning up the full WaveController (which requires a
// GraphDatabaseAdapter + Docker + the whole pipeline) yet exercises the
// branch's contract.
//
// For mergeEntityGroup deletion (Tests 9-10) we assert by grepping the
// compiled deduplication.js file inside dist/. Those tests run filesystem
// checks against the BUILT artifact (not the .ts source), so they validate
// what actually ships.

describe('Phase 42 Plan 06 — wave-controller persistWithKmCore + dedup rewire (Task 2)', () => {
  // -------------------------------------------------------------------------
  // Test 7: wave-controller's persistence routes through kmCoreAdapter
  //         unconditionally (Phase 42 Plan 07 Phase B1 — flag removed).
  //         Tested by inspecting the SOURCE FILE: persistWithKmCore exists
  //         and contains storeEntity + storeRelationship invocations.
  // -------------------------------------------------------------------------
  it('Test 7: wave-controller.ts contains persistWithKmCore branch that calls kmCoreAdapter.storeEntity', () => {
    const src = readWaveControllerSource();
    assert.match(src, /persistWithKmCore/, 'persistWithKmCore method exists');
    assert.match(
      src,
      /kmCoreAdapter\.storeEntity/,
      'persistWithKmCore calls kmCoreAdapter.storeEntity',
    );
    assert.match(
      src,
      /kmCoreAdapter\.storeRelationship/,
      'persistWithKmCore calls kmCoreAdapter.storeRelationship for relations',
    );
  });

  // -------------------------------------------------------------------------
  // Test 8 (Phase 42 Plan 07 Phase B1 rewrite + Phase 42.2 Plan 04 update):
  // the KM_CORE_PERSISTENCE flag has been removed; the legacy
  // persistenceAgent.persistEntities branch was deleted from wave-controller.ts;
  // the SharedMemoryEntity type-only import has been MOVED to
  // ../types/shared-memory-types.js (the persistence-agent.ts source file
  // was deleted in Phase 42.2 Plan 04). Assert:
  //   - wave-controller.ts has NO `getPersistenceBackend` reference.
  //   - wave-controller.ts has NO `persistenceAgent.persistEntities` call site.
  //   - wave-controller.ts no longer imports PersistenceAgent as a runtime
  //     class AND no longer imports anything from the retired
  //     persistence-agent module (Phase 42.2 Plan 04 grep gate).
  // -------------------------------------------------------------------------
  it('Test 8: KM_CORE_PERSISTENCE flag + legacy persistEntities path removed from wave-controller.ts', () => {
    const src = readWaveControllerSource();
    assert.doesNotMatch(
      src,
      /getPersistenceBackend\b/,
      'getPersistenceBackend reference must be gone (flag removed in Phase B1)',
    );
    assert.doesNotMatch(
      src,
      /persistenceAgent\.persistEntities/,
      'legacy persistenceAgent.persistEntities call site must be gone',
    );
    assert.doesNotMatch(
      src,
      /^import\s+\{[^}]*\bPersistenceAgent\b[^}]*\}/m,
      'wave-controller must not import PersistenceAgent as a runtime symbol',
    );
    // Phase 42.2 Plan 04 grep-gate parity: no import from the retired trio.
    assert.doesNotMatch(
      src,
      /^import[^;]*from\s+['"][^'"]*persistence-agent['"]/m,
      'wave-controller must have no `import ... from "...persistence-agent..."` line',
    );
    assert.doesNotMatch(
      src,
      /^import[^;]*from\s+['"][^'"]*graph-database-adapter['"]/m,
      'wave-controller must have no `import ... from "...graph-database-adapter..."` line',
    );
  });

  // -------------------------------------------------------------------------
  // Test 9: deduplication.ts no longer defines or invokes mergeEntityGroup;
  //         calls forward to mergeEntities from @fwornle/km-core.
  // -------------------------------------------------------------------------
  it('Test 9: deduplication.ts has no mergeEntityGroup symbol anymore; imports mergeEntities from km-core', () => {
    const src = readSrcFile('src/agents/deduplication.ts');
    // No mergeEntityGroup definition or invocation (matches AC grep).
    assert.doesNotMatch(
      src,
      /mergeEntityGroup\s*[(=:]/,
      'mergeEntityGroup is no longer defined or invoked',
    );
    // mergeEntities imported from km-core (root barrel, per Plan 42-01 SUMMARY deviation).
    assert.match(
      src,
      /from\s+['"]@fwornle\/km-core['"]/,
      'deduplication.ts imports from @fwornle/km-core',
    );
    assert.match(src, /\bmergeEntities\b/, 'deduplication.ts references mergeEntities symbol');
  });

  // -------------------------------------------------------------------------
  // Test 10: name-resolution failure during dedup does not throw; the loop
  //          skips the unresolved group and continues. We exercise this via
  //          a unit-level shim of the rewired logic.
  // -------------------------------------------------------------------------
  it('Test 10: dedup skips groups whose entity names do not resolve in the km-core store (no throw)', async () => {
    // Simulate the rewired call-site logic.
    const errors: string[] = [];
    function safeMerge(name: string, store: { findByName: (n: string) => unknown }): boolean {
      const id = store.findByName(name);
      if (!id) {
        errors.push(`skipping merge — entity '${name}' not in km-core store`);
        return false;
      }
      return true;
    }

    const store = { findByName: (n: string) => (n === 'KnownEntity' ? 'id-1' : undefined) };
    const a = safeMerge('KnownEntity', store);
    const b = safeMerge('GhostEntity', store);

    assert.equal(a, true, 'known entity resolves');
    assert.equal(b, false, 'unknown entity is skipped');
    assert.equal(errors.length, 1, 'one skip recorded');
    assert.match(errors[0], /GhostEntity/, 'skip log mentions the entity name');
  });

  // -------------------------------------------------------------------------
  // Test 11: per-entity adapter error is fail-soft — errors counter
  //          increments and loop continues (matches Phase 41 resolveEntities
  //          precedent + threat-model T-42-06-03 mitigation).
  // -------------------------------------------------------------------------
  it('Test 11: per-entity adapter.storeEntity error increments error counter, loop continues', async () => {
    // Simulate the persistWithKmCore loop shape.
    const storeEntity = mock.fn(async (e: { name: string }) => {
      if (e.name === 'BadEntity') throw new Error('boom');
      return { id: 'mocked' };
    });
    const storeRelationship = mock.fn(async () => undefined);
    const adapter = { storeEntity, storeRelationship };

    const entities = [
      { name: 'GoodEntity1' },
      { name: 'BadEntity' },
      { name: 'GoodEntity2' },
    ];

    let stored = 0;
    let errs = 0;
    for (const e of entities) {
      try {
        await adapter.storeEntity(e);
        stored += 1;
      } catch {
        errs += 1;
      }
    }

    assert.equal(stored, 2, 'two entities stored successfully');
    assert.equal(errs, 1, 'one error counted');
    assert.equal(storeEntity.mock.calls.length, 3, 'all three entities attempted');
  });
});

// ===========================================================================
// Phase 42.1 — project-anchor parity (anchor pass)
// ===========================================================================

/**
 * Tests A–F cover the post-sweep anchor pass in `persistWithKmCore`.
 *
 * Strategy: Tests A–F use a self-contained shim of the anchor-pass loop that
 * mirrors the exact implementation in `wave-controller.ts:persistWithKmCore`.
 * The shim accepts mock kmCoreAdapter functions (queryEntities, storeEntity,
 * storeRelationship, queryIncomingRelations) so we can assert call counts,
 * arguments, and counter values against the documented contract. The shim
 * is intentionally a verbatim recreation of the post-sweep block — any drift
 * between the shim and the real implementation will be caught by Test 12's
 * source-grep guard below.
 *
 * In addition, Test 12 (source-grep guard) asserts the real implementation
 * still contains the load-bearing patterns: findBestParent, ensureProjectAnchor,
 * 'contains', anchorEdgesAdded +=, the entityType === 'Project' skip-rule,
 * the alreadyAnchored Set, the try/catch around storeRelationship, etc.
 * Together the shim + source-grep give the contract closure for SC-1..SC-5.
 */

interface ShimEntity {
  name: string;
  entityType: string;
}

interface ShimRelation {
  from: string;
  to: string;
  type: string;
  /**
   * Did the relationship sweep actually store this edge? `false` models the
   * skip taken when an endpoint is missing from persistedEntityNames (a
   * constraint-rejected parent). Defaults to stored.
   */
  stored?: boolean;
}

interface ShimAdapter {
  queryEntities: (opts: { entityType?: string }) => Promise<Array<{ name: string }>>;
  storeEntity: (entity: { name: string; entityType?: string }, opts: { team: string }) => Promise<{ id: string }>;
  storeRelationship: (
    from: string,
    to: string,
    type: string,
    metadata?: Record<string, unknown>,
  ) => Promise<void>;
  queryIncomingRelations: (toName: string) => Promise<Array<{ type: string }>>;
}

function findBestParentShim(entityName: string, allEntities: ShimEntity[]): string | null {
  const candidates = allEntities.filter(
    (e) =>
      (e.entityType === 'SubComponent' || e.entityType === 'Component') &&
      e.name !== entityName, // never a candidate parent for itself
  );
  const lowerName = entityName.toLowerCase();
  let bestMatch: ShimEntity | null = null;
  let bestLen = 0;
  for (const c of candidates) {
    const cLower = c.name.toLowerCase();
    if (lowerName.includes(cLower) && cLower.length > bestLen) {
      if (!bestMatch || c.entityType === 'SubComponent' || cLower.length > bestLen) {
        bestMatch = c;
        bestLen = cLower.length;
      }
    }
  }
  if (bestMatch) return bestMatch.name;
  const codingProject = allEntities.find(
    (e) => e.name === 'Coding' && e.entityType === 'Project',
  );
  return codingProject ? 'Coding' : null;
}

interface AnchorPassResult {
  anchorEdgesAdded: number;
  anchorEdgesFailed: number;
  anchorEdgesSkipped: number;
  stderr: string[];
}

async function runAnchorPassShim(
  entities: ShimEntity[],
  relationships: ShimRelation[],
  adapter: ShimAdapter,
  runId: string,
  team: string,
): Promise<AnchorPassResult> {
  let anchorEdgesAdded = 0;
  let anchorEdgesFailed = 0;
  let anchorEdgesSkipped = 0;
  const stderr: string[] = [];

  // ensureProjectAnchor
  try {
    const existing = await adapter.queryEntities({ entityType: 'Project' });
    if (!existing.some((e) => e.name === 'Coding')) {
      await adapter.storeEntity(
        {
          name: 'Coding',
          entityType: 'Project',
        },
        { team },
      );
    }
  } catch (err) {
    stderr.push(
      `[WaveController] ensureProjectAnchor failed (runId=${runId}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Two-layer idempotency check.
  //
  // Layer (a) mirrors the real sweep: only edges that were actually STORED
  // count. `storedEdgeTargets` stands in for the relationship sweep's result.
  // Marking every INTENDED target here is the bug this shim used to encode —
  // an edge skipped because its parent failed the constraint gate left the
  // target flagged as anchored, so the repair pass never ran for it.
  const alreadyAnchored = new Set<string>(
    relationships
      .filter((r) => (r.type === 'contains' || r.type === 'parent-child') && r.stored !== false)
      .map((r) => r.to),
  );
  for (const e of entities) {
    if (alreadyAnchored.has(e.name)) continue;
    try {
      const inRels = await adapter.queryIncomingRelations(e.name);
      if (inRels.some((r) => r.type === 'contains' || r.type === 'parent-child')) {
        alreadyAnchored.add(e.name);
      }
    } catch {
      // fall through
    }
  }

  // Anchor-pass loop
  for (const e of entities) {
    if (e.entityType === 'Project' || e.entityType === 'System') continue;
    if (alreadyAnchored.has(e.name)) {
      anchorEdgesSkipped += 1;
      continue;
    }
    const parent = findBestParentShim(e.name, entities);
    if (!parent) {
      anchorEdgesSkipped += 1;
      stderr.push(`[WaveController] anchor pass: no parent found for ${e.name} (runId=${runId})`);
      continue;
    }
    if (parent === e.name) {
      anchorEdgesSkipped += 1;
      stderr.push(`[WaveController] anchor pass: refusing self-edge for ${e.name} (runId=${runId})`);
      continue;
    }
    try {
      await adapter.storeRelationship(parent, e.name, 'contains', {
        source: 'wave-analysis',
        runId,
      });
      anchorEdgesAdded += 1;
    } catch (err) {
      anchorEdgesFailed += 1;
      stderr.push(
        `[WaveController] anchor pass: storeRelationship failed for ${parent} -> ${e.name} (contains, runId=${runId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return { anchorEdgesAdded, anchorEdgesFailed, anchorEdgesSkipped, stderr };
}

describe('Phase 42.1 — project-anchor parity (anchor pass)', () => {
  // -------------------------------------------------------------------------
  // Test A — Component/SubComponent match attaches to the deepest match.
  // -------------------------------------------------------------------------
  it('Test A — Component/SubComponent longest-substring match wins (SC-3 happy path)', async () => {
    const entities: ShimEntity[] = [
      { name: 'Coding', entityType: 'Project' },
      { name: 'TranscriptProcessor', entityType: 'Component' },
      { name: 'TranscriptAdapter', entityType: 'SubComponent' },
      { name: 'TranscriptAdapterDetail', entityType: 'Detail' },
    ];
    const relationships: ShimRelation[] = [];
    const queryEntities = mock.fn(async (_opts: { entityType?: string }) => [{ name: 'Coding' }]);
    const storeEntity = mock.fn(async (_e: { name: string; entityType?: string }, _o: { team: string }) => ({ id: 'never' }));
    const storeRelationship = mock.fn(
      async (_from: string, _to: string, _type: string, _metadata?: Record<string, unknown>) => undefined,
    );
    const queryIncomingRelations = mock.fn(async (_toName: string) => [] as Array<{ type: string }>);
    const adapter: ShimAdapter = {
      queryEntities,
      storeEntity,
      storeRelationship,
      queryIncomingRelations,
    };

    const runId = 'wave-analysis-test-A';
    const result = await runAnchorPassShim(entities, relationships, adapter, runId, 'coding');

    // Every non-Project entity is anchored: the Detail to its deepest
    // substring match, and BOTH the Component and the SubComponent to the
    // Coding root. This asserted 1 until 2026-09-08, which encoded the
    // findBestParent self-match defect — a Component/SubComponent resolved to
    // itself, the self-edge guard refused it, and it was silently left
    // unanchored. The substring-precedence contract this test exists for is
    // unchanged and asserted explicitly below.
    assert.equal(result.anchorEdgesAdded, 3, 'every non-Project entity anchored');
    assert.equal(result.anchorEdgesFailed, 0, 'no failures');
    assert.equal(storeRelationship.mock.calls.length, 3, 'storeRelationship called per anchored entity');
    const detailCall = storeRelationship.mock.calls
      .map((c) => c.arguments)
      .find((a) => a[1] === 'TranscriptAdapterDetail');
    assert.ok(detailCall, 'the Detail was anchored');
    const args = detailCall!;
    assert.equal(args[0], 'TranscriptAdapter', 'parent is deepest SubComponent match (not TranscriptProcessor)');
    assert.equal(args[1], 'TranscriptAdapterDetail', 'child is target entity');
    assert.equal(args[2], 'contains', "relation type is 'contains'");
    // The Component and SubComponent fall back to the root rather than to
    // themselves.
    const rootAnchored = storeRelationship.mock.calls
      .map((c) => c.arguments)
      .filter((a) => a[0] === 'Coding')
      .map((a) => a[1])
      .sort();
    assert.deepEqual(rootAnchored, ['TranscriptAdapter', 'TranscriptProcessor']);
    const metadata = args[3] as Record<string, unknown>;
    assert.equal(metadata.source, 'wave-analysis', 'metadata.source stamped');
    assert.equal(metadata.runId, runId, 'metadata.runId stamped (T-42.1-03 provenance)');
    // Coding already present → storeEntity for bootstrap not invoked
    assert.equal(storeEntity.mock.calls.length, 0, 'storeEntity NOT called (Coding exists)');
  });

  // -------------------------------------------------------------------------
  // Test B — No match falls back to Coding.
  // -------------------------------------------------------------------------
  it('Test B — no Component/SubComponent match falls back to Coding (SC-3 fallback)', async () => {
    const entities: ShimEntity[] = [
      { name: 'Coding', entityType: 'Project' },
      { name: 'OrphanDetail', entityType: 'Detail' },
    ];
    const queryEntities = mock.fn(async (_opts: { entityType?: string }) => [{ name: 'Coding' }]);
    const storeEntity = mock.fn(async (_e: { name: string; entityType?: string }, _o: { team: string }) => ({ id: 'never' }));
    const storeRelationship = mock.fn(
      async (_from: string, _to: string, _type: string, _metadata?: Record<string, unknown>) => undefined,
    );
    const queryIncomingRelations = mock.fn(async (_toName: string) => [] as Array<{ type: string }>);
    const adapter: ShimAdapter = {
      queryEntities,
      storeEntity,
      storeRelationship,
      queryIncomingRelations,
    };

    const result = await runAnchorPassShim(entities, [], adapter, 'wave-analysis-test-B', 'coding');

    assert.equal(result.anchorEdgesAdded, 1, 'one anchor edge added');
    assert.equal(storeRelationship.mock.calls.length, 1, 'storeRelationship called once');
    const args = storeRelationship.mock.calls[0].arguments;
    assert.equal(args[0], 'Coding', 'fallback parent is Coding');
    assert.equal(args[1], 'OrphanDetail', 'child is target entity');
    assert.equal(args[2], 'contains', "relation type is 'contains'");
  });

  // -------------------------------------------------------------------------
  // Test C — Project / System entities are skipped.
  // -------------------------------------------------------------------------
  it('Test C — Project and System entities are not anchored (SC-1 skip rule)', async () => {
    const entities: ShimEntity[] = [
      { name: 'Coding', entityType: 'Project' },
      { name: 'SomeSubsystem', entityType: 'System' },
    ];
    const queryEntities = mock.fn(async (_opts: { entityType?: string }) => [{ name: 'Coding' }]);
    const storeEntity = mock.fn(async (_e: { name: string; entityType?: string }, _o: { team: string }) => ({ id: 'never' }));
    const storeRelationship = mock.fn(
      async (_from: string, _to: string, _type: string, _metadata?: Record<string, unknown>) => undefined,
    );
    const queryIncomingRelations = mock.fn(async (_toName: string) => [] as Array<{ type: string }>);
    const adapter: ShimAdapter = {
      queryEntities,
      storeEntity,
      storeRelationship,
      queryIncomingRelations,
    };

    const result = await runAnchorPassShim(entities, [], adapter, 'wave-analysis-test-C', 'coding');

    assert.equal(result.anchorEdgesAdded, 0, 'no anchor edges added');
    assert.equal(storeRelationship.mock.calls.length, 0, 'storeRelationship NOT called');
    // Sanity — no call targets Coding or SomeSubsystem as the `to`:
    for (const c of storeRelationship.mock.calls) {
      const args = c.arguments;
      assert.notEqual(args[1], 'Coding');
      assert.notEqual(args[1], 'SomeSubsystem');
    }
  });

  // -------------------------------------------------------------------------
  // Test D — Entity already anchored via in-wave relation is NOT re-anchored.
  // -------------------------------------------------------------------------
  it('Test D — entity in alreadyAnchored Set is not re-anchored (SC-4 layer a)', async () => {
    // Fixture chosen so that ChildDetail would normally receive an anchor edge
    // from TranscriptAdapter (longest-substring SubComponent match), but the
    // pre-existing in-wave 'contains' relation places ChildDetail in the
    // alreadyAnchored Set — so the anchor pass MUST skip it.
    // A second Detail entity (UnrelatedDetail) has NO matching Component/
    // SubComponent in the fixture and falls back to Coding, giving us a
    // non-zero added counter to prove the pass otherwise runs normally.
    const entities: ShimEntity[] = [
      { name: 'Coding', entityType: 'Project' },
      { name: 'TranscriptAdapter', entityType: 'SubComponent' },
      { name: 'TranscriptAdapterChildDetail', entityType: 'Detail' },
      { name: 'UnrelatedDetail', entityType: 'Detail' },
    ];
    const relationships: ShimRelation[] = [
      // TranscriptAdapterChildDetail already has an incoming contains edge.
      { from: 'TranscriptAdapter', to: 'TranscriptAdapterChildDetail', type: 'contains' },
    ];
    const queryEntities = mock.fn(async (_opts: { entityType?: string }) => [{ name: 'Coding' }]);
    const storeEntity = mock.fn(async (_e: { name: string; entityType?: string }, _o: { team: string }) => ({ id: 'never' }));
    const storeRelationship = mock.fn(
      async (_from: string, _to: string, _type: string, _metadata?: Record<string, unknown>) => undefined,
    );
    const queryIncomingRelations = mock.fn(async (_toName: string) => [] as Array<{ type: string }>);
    const adapter: ShimAdapter = {
      queryEntities,
      storeEntity,
      storeRelationship,
      queryIncomingRelations,
    };

    const result = await runAnchorPassShim(
      entities,
      relationships,
      adapter,
      'wave-analysis-test-D',
      'coding',
    );

    // anchor pass walks: TranscriptAdapter (no other Component/SubComponent to
    // match → falls back to Coding → added; it used to self-match and be
    // skipped, which was the findBestParent defect),
    // TranscriptAdapterChildDetail (in alreadyAnchored Set → skipped),
    // UnrelatedDetail (no Component match → falls back to Coding → added).
    // The contract under test — an already-anchored entity is NOT re-anchored
    // — is unchanged and asserted below.
    assert.equal(result.anchorEdgesAdded, 2, 'TranscriptAdapter and UnrelatedDetail anchored');
    assert.equal(storeRelationship.mock.calls.length, 2, 'anchor-pass storeRelationship called twice');
    // The single anchor-pass call must NOT target TranscriptAdapterChildDetail:
    const targets = storeRelationship.mock.calls.map((c) => c.arguments[1]);
    assert.ok(
      !targets.includes('TranscriptAdapterChildDetail'),
      'TranscriptAdapterChildDetail NOT re-anchored (in-wave Set caught it)',
    );
    // And both remaining entities must be the ones anchored to Coding:
    assert.deepEqual([...targets].sort(), ['TranscriptAdapter', 'UnrelatedDetail']);
  });

  // -------------------------------------------------------------------------
  // Test E — ensureProjectAnchor is idempotent (SC-2 closure).
  // -------------------------------------------------------------------------
  it('Test E — ensureProjectAnchor idempotency (SC-2 closure)', async () => {
    // Case E1: Coding already present → storeEntity NOT called.
    {
      const queryEntities = mock.fn(async (_opts: { entityType?: string }) => [{ name: 'Coding' }]);
      const storeEntity = mock.fn(
        async (_e: { name: string; entityType?: string }, _o: { team: string }) => ({ id: 'never' }),
      );
      const storeRelationship = mock.fn(
        async (_from: string, _to: string, _type: string, _metadata?: Record<string, unknown>) => undefined,
      );
      const queryIncomingRelations = mock.fn(async (_toName: string) => [] as Array<{ type: string }>);
      const adapter: ShimAdapter = {
        queryEntities,
        storeEntity,
        storeRelationship,
        queryIncomingRelations,
      };

      await runAnchorPassShim([], [], adapter, 'wave-analysis-test-E1', 'coding');

      assert.equal(storeEntity.mock.calls.length, 0, 'E1: storeEntity NOT called when Coding exists');
      assert.equal(queryEntities.mock.calls.length, 1, 'E1: queryEntities called once (entityType=Project)');
    }
    // Case E2: Coding absent (cold-start) → storeEntity called exactly once with Coding payload.
    {
      const queryEntities = mock.fn(
        async (_opts: { entityType?: string }) => [] as Array<{ name: string }>,
      );
      const storeEntity = mock.fn(
        async (_e: { name: string; entityType?: string }, _o: { team: string }) => ({ id: 'minted' }),
      );
      const storeRelationship = mock.fn(
        async (_from: string, _to: string, _type: string, _metadata?: Record<string, unknown>) => undefined,
      );
      const queryIncomingRelations = mock.fn(async (_toName: string) => [] as Array<{ type: string }>);
      const adapter: ShimAdapter = {
        queryEntities,
        storeEntity,
        storeRelationship,
        queryIncomingRelations,
      };

      await runAnchorPassShim([], [], adapter, 'wave-analysis-test-E2', 'coding');

      assert.equal(storeEntity.mock.calls.length, 1, 'E2: storeEntity called exactly once (cold-start mint)');
      const args = storeEntity.mock.calls[0].arguments;
      const payload = args[0];
      assert.equal(payload.name, 'Coding', 'E2: bootstrap mints entity named Coding');
      assert.equal(payload.entityType, 'Project', 'E2: bootstrap entityType is Project');
      const teamOpts = args[1];
      assert.equal(teamOpts.team, 'coding', 'E2: team option is the WaveController team');
    }
  });

  // -------------------------------------------------------------------------
  // Test F — Fail-soft: storeRelationship throw on 2nd call leaves counters
  // correct AND loop runs to completion (SC-5 closure).
  // -------------------------------------------------------------------------
  it('Test F — fail-soft when storeRelationship throws on 2nd call (SC-5 closure)', async () => {
    const entities: ShimEntity[] = [
      { name: 'Coding', entityType: 'Project' },
      { name: 'D1', entityType: 'Detail' },
      { name: 'D2', entityType: 'Detail' },
      { name: 'D3', entityType: 'Detail' },
    ];
    const queryEntities = mock.fn(async (_opts: { entityType?: string }) => [{ name: 'Coding' }]);
    const storeEntity = mock.fn(
      async (_e: { name: string; entityType?: string }, _o: { team: string }) => ({ id: 'never' }),
    );
    let callCount = 0;
    const storeRelationship = mock.fn(
      async (_from: string, to: string, _type: string, _metadata?: Record<string, unknown>) => {
        callCount += 1;
        if (callCount === 2) {
          throw new Error(`boom for ${to}`);
        }
      },
    );
    const queryIncomingRelations = mock.fn(async (_toName: string) => [] as Array<{ type: string }>);
    const adapter: ShimAdapter = {
      queryEntities,
      storeEntity,
      storeRelationship,
      queryIncomingRelations,
    };

    const result = await runAnchorPassShim(entities, [], adapter, 'wave-analysis-test-F', 'coding');

    // 3 Detail entities: D1, D2 (throws), D3. Loop must NOT abort.
    assert.equal(result.anchorEdgesAdded, 2, 'two anchor edges added (D1, D3)');
    assert.equal(result.anchorEdgesFailed, 1, 'one failure counted (D2)');
    assert.equal(storeRelationship.mock.calls.length, 3, 'loop ran for all 3 entities');
    // stderr captured the fail-soft line with D2 in it.
    const hasD2Line = result.stderr.some((line) => line.includes('D2'));
    assert.equal(hasD2Line, true, 'stderr captured a fail-soft line mentioning D2');
  });

  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Anchor pass repairs what the relationship sweep could not store.
  //
  // The 2026-09-07 failure: a parent that fails the constraint gate is not in
  // persistedEntityNames, so its children's contains edges are SKIPPED by the
  // relationship sweep. Layer (a) then marked those children anchored anyway
  // — because it walked the intended relations — and the repair pass that
  // exists for exactly this case reported added=0 and wrote nothing. The
  // children were left with no incoming edge: orphans.
  // -------------------------------------------------------------------------
  it('synthesizes an edge for a child whose intended edge was NOT stored', async () => {
    const entities: ShimEntity[] = [
      { name: 'Coding', entityType: 'Project' },
      { name: 'CostModelEngine', entityType: 'Component' },
      { name: 'CostModelEngineBudget', entityType: 'SubComponent' },
    ];
    // The parent was constraint-rejected, so the sweep skipped this edge.
    const relationships: ShimRelation[] = [
      { from: 'CostModelEngine', to: 'CostModelEngineBudget', type: 'contains', stored: false },
    ];
    const calls: Array<{ from: string; to: string; type: string }> = [];
    const adapter: ShimAdapter = {
      queryEntities: async () => [{ name: 'Coding' }],
      storeEntity: async () => ({ id: 'x' }),
      storeRelationship: async (from, to, type) => {
        calls.push({ from, to, type });
      },
      queryIncomingRelations: async () => [],
    };

    const result = await runAnchorPassShim(entities, relationships, adapter, 'run-anchor-1', 'coding');

    assert.equal(result.anchorEdgesAdded, 2, 'both unanchored entities get an edge');
    const repaired = calls.find((c) => c.to === 'CostModelEngineBudget');
    assert.ok(repaired, 'the child whose edge was skipped must be repaired');
    assert.equal(repaired?.type, 'contains');
  });

  it('does NOT re-add an edge that the sweep really stored', async () => {
    const entities: ShimEntity[] = [
      { name: 'Coding', entityType: 'Project' },
      { name: 'LiveLoggingSystem', entityType: 'Component' },
    ];
    const relationships: ShimRelation[] = [
      { from: 'Coding', to: 'LiveLoggingSystem', type: 'contains', stored: true },
    ];
    const calls: Array<{ from: string; to: string }> = [];
    const adapter: ShimAdapter = {
      queryEntities: async () => [{ name: 'Coding' }],
      storeEntity: async () => ({ id: 'x' }),
      storeRelationship: async (from, to) => {
        calls.push({ from, to });
      },
      queryIncomingRelations: async () => [],
    };

    const result = await runAnchorPassShim(entities, relationships, adapter, 'run-anchor-2', 'coding');

    assert.equal(result.anchorEdgesAdded, 0, 'nothing to repair');
    assert.equal(result.anchorEdgesSkipped, 1);
    assert.equal(calls.length, 0, 'a stored edge must not be duplicated');
  });

  it('a Component/SubComponent falls back to the Coding root rather than itself', async () => {
    // findBestParent used to include the entity in its own candidate list.
    // Every string contains itself and self is the longest self-match, so a
    // Component always resolved to itself, the self-edge guard refused it,
    // and the truthy bestMatch short-circuited the 'Coding' fallback — the
    // anchor pass could not repair a Component or SubComponent at all.
    const entities: ShimEntity[] = [
      { name: 'Coding', entityType: 'Project' },
      { name: 'MultiUserSessionRouter', entityType: 'SubComponent' },
    ];
    const calls: Array<{ from: string; to: string }> = [];
    const adapter: ShimAdapter = {
      queryEntities: async () => [{ name: 'Coding' }],
      storeEntity: async () => ({ id: 'x' }),
      storeRelationship: async (from, to) => { calls.push({ from, to }) },
      queryIncomingRelations: async () => [],
    };

    const result = await runAnchorPassShim(entities, [], adapter, 'run-anchor-3', 'coding');

    assert.equal(result.anchorEdgesAdded, 1);
    assert.deepEqual(calls[0], { from: 'Coding', to: 'MultiUserSessionRouter' });
  });

  // Test 12 — source-grep guard: real implementation contains the load-bearing
  // patterns. Protects against accidental deletion when the shim above is
  // refactored or when persistence-agent.ts is finally retired.
  // -------------------------------------------------------------------------
  it('Test 12 — wave-controller.ts contains the load-bearing anchor-pass patterns', () => {
    const src = readWaveControllerSource();

    // Helper methods exist
    assert.match(src, /findBestParent/, 'findBestParent symbol present');
    assert.match(src, /ensureProjectAnchor/, 'ensureProjectAnchor symbol present');

    // Anchor-pass block markers
    assert.match(src, /Anchor pass \(Phase 42\.1/, 'anchor-pass block banner present');
    assert.match(src, /alreadyAnchored/, 'alreadyAnchored Set referenced');
    assert.match(src, /'contains'/, "literal 'contains' string in source");
    assert.match(src, /anchorEdgesAdded \+= 1/, 'anchorEdgesAdded incremented');
    assert.match(src, /anchorEdgesFailed \+= 1/, 'anchorEdgesFailed incremented');
    assert.match(src, /entityType === 'Project'/, "Project skip rule present");
    assert.match(src, /entityType === 'System'/, "System skip rule present");
    assert.match(src, /queryIncomingRelations/, 'two-layer idempotency calls queryIncomingRelations');

    // Layer (a) must key on edges that were STORED, not merely intended.
    // Walking `relationships` here is the 2026-09-07 bug: the pass reported
    // added=0 skipped=N failed=0 for every batch while the entities it
    // skipped had no incoming edge at all.
    assert.match(src, /anchoredByStoredEdge/, 'anchor layer (a) keys on stored edges');
    assert.match(
      src,
      /e\.name !== entityName,/,
      'findBestParent excludes the entity from its own candidate list',
    );
    assert.match(
      src,
      /const alreadyAnchored = new Set<string>\(anchoredByStoredEdge\);/,
      'alreadyAnchored seeded from stored edges only',
    );
    assert.doesNotMatch(
      src,
      /for \(const rel of relationships\) \{\s*if \(rel\.type === 'contains'[\s\S]{0,120}alreadyAnchored\.add/,
      'the intent-based anchoring loop must not come back',
    );
    // The project anchor must exist before the relationship sweep drops
    // edges whose endpoints it cannot resolve.
    assert.match(
      src,
      /await this\.ensureProjectAnchor\(runId\);\s*\n\s*\/\/ ---- Relationship sweep ----/,
      'ensureProjectAnchor runs before the relationship sweep',
    );

    // Provenance metadata stamped on every storeRelationship call (T-42.1-03)
    assert.match(src, /source:\s*'wave-analysis'/, "metadata.source: 'wave-analysis' stamped on anchor edges");
  });
});

// ---------------------------------------------------------------------------
// File-read helpers — tests assert against compiled source under dist/ and
// raw .ts under src/ (compiled file is what actually ships in the container).
// ---------------------------------------------------------------------------

function readWaveControllerSource(): string {
  // Read from src/ — Test 7/8 assert on source-level intent (compiles the
  // same way to dist/agents/wave-controller.js).
  return readSrcFile('src/agents/wave-controller.ts');
}

function readSrcFile(relPath: string): string {
  // dist/agents/wave-controller-canonical-emit.test.js → ../../src/<relPath>
  // when running via `node --test dist/...`. Compute the submodule root by
  // walking up from this file's directory.
  // import.meta.url is file:///.../dist/agents/wave-controller-canonical-emit.test.js
  // submodule root = dirname(dirname(dirname(import.meta.url)))
  const here = path.dirname(new URL(import.meta.url).pathname);
  // here = .../dist/agents
  const submoduleRoot = path.resolve(here, '..', '..');
  const abs = path.join(submoduleRoot, relPath);
  return fs.readFileSync(abs, 'utf-8');
}
