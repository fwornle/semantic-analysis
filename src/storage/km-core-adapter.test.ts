/**
 * Unit tests for the km-core strangler adapter.
 *
 * Phase 42 Plan 01 — TDD red/green for:
 *   - createKmCoreAdapter() factory + hot-path surface (Tests 4-5)
 *   - Wave-controller bypass write rewire (Tests 6-8, added in Task 2)
 *
 * Phase 42 Plan 07 Phase B1 update: the persistence-backend feature flag
 * (`KM_CORE_PERSISTENCE`) has been REMOVED. The previous persistence-flag
 * describe-block (Tests 1-3) is gone — km-core is now unconditional.
 *
 * Run via: `npm run build && node --test dist/storage/km-core-adapter.test.js`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createKmCoreAdapter, type KmCoreAdapter } from './km-core-adapter.js';

// ---------------------------------------------------------------------------
// Stub km-core store — exposes only the surface the adapter calls.
// ---------------------------------------------------------------------------

interface StubEntity {
  id: string;
  name: string;
  entityType: string;
  ontologyClass?: string;
  layer: 'evidence' | 'pattern';
  description: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  legacyId?: { system: string; id: string };
  [key: string]: unknown;
}

class StubGraphKMStore {
  // Calls captured for assertions:
  public mergeAttributesCalls: Array<{ id: string; attrs: Record<string, unknown> }> = [];
  /** What the ADAPTER passed — `id` absent here means "mint me a new node". */
  public putEntityArgs: Array<Partial<StubEntity>> = [];
  /** What ended up stored, after the store stamped a minted id. */
  public putEntityCalls: StubEntity[] = [];
  public addRelationCalls: Array<{ type: string; from: string; to: string; metadata?: unknown }> = [];
  public batchCalls: unknown[] = [];

  // In-memory store keyed by id — NOT by name. The real graph is keyed by
  // EntityId and can hold several nodes sharing a name; a name-keyed stub
  // cannot represent the duplicate-node bug at all.
  private byId = new Map<string, StubEntity>();

  seed(entity: StubEntity): void {
    this.byId.set(entity.id, entity);
  }

  async mergeAttributes(id: string, attrs: Record<string, unknown>): Promise<void> {
    this.mergeAttributesCalls.push({ id, attrs });
    const existing = this.byId.get(id);
    if (!existing) {
      throw new Error(`Node ${id} not found in graph`);
    }
    this.byId.set(id, { ...existing, ...attrs });
  }

  async putEntity(entity: StubEntity, _opts?: unknown): Promise<string> {
    // km-core's putEntity returns EntityId; stamp one if the caller omitted.
    this.putEntityArgs.push({ ...entity });
    const id = entity.id ?? `01902b78-3c4a-7000-9000-${String(this.putEntityCalls.length).padStart(12, '0')}`;
    const stored = { ...entity, id };
    this.putEntityCalls.push(stored);
    this.byId.set(stored.id, stored);
    return id;
  }

  async getEntity(id: string): Promise<StubEntity | undefined> {
    return this.byId.get(id);
  }

  async findByOntologyClass(klass: string): Promise<StubEntity[]> {
    const out: StubEntity[] = [];
    for (const e of this.byId.values()) if (e.ontologyClass === klass) out.push(e);
    return out;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async *iterate(): AsyncIterable<StubEntity> {
    for (const e of this.byId.values()) yield e;
  }

  async addRelation(r: { type: string; from: string; to: string; metadata?: unknown }): Promise<void> {
    this.addRelationCalls.push(r);
  }

  async batch(ops: unknown[]): Promise<void> {
    this.batchCalls.push(...ops);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshEntity(name: string, klass: string): StubEntity {
  const now = new Date('2026-05-23T00:00:00.000Z').toISOString();
  return {
    id: `01902b78-3c4a-7000-9000-${name.padStart(12, '0').slice(0, 12)}`,
    name,
    entityType: klass,
    ontologyClass: klass,
    layer: 'evidence',
    description: `${name} description`,
    createdAt: now,
    updatedAt: now,
    metadata: { subsystem: 'wave-analysis' },
    legacyId: { system: 'B', id: `legacy-${name}` },
  };
}

// ---------------------------------------------------------------------------
// Section 1: getPersistenceBackend() — REMOVED in Phase 42 Plan 07 Phase B1.
// The persistence-flag module + its describe-block (Tests 1-3) were deleted
// when the km-core path became unconditional.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Section 2: createKmCoreAdapter() — Tests 4, 5 (hot-path surface + cold-path stubs)
// ---------------------------------------------------------------------------

describe('km-core-adapter — surface', () => {
  it('surface — Test 4: factory returns object with the documented async methods', () => {
    const store = new StubGraphKMStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter: KmCoreAdapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    for (const m of [
      'mergeAttributes',
      'queryEntities',
      'storeEntity',
      'storeRelationship',
      'getEntity',
      'deleteEntity',
    ]) {
      assert.equal(typeof (adapter as unknown as Record<string, unknown>)[m], 'function', `missing method: ${m}`);
    }
  });

  it('surface — Test 5: the remaining cold-path methods throw NotImplementedError', async () => {
    const store = new StubGraphKMStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    // `queryRelations` left this list in stage 3 — see Test 5b. The other two
    // are still stubs, and this asserts they did not quietly follow it.
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).queryByOntologyClass({}),
      /NotImplementedError: km-core-adapter\.queryByOntologyClass/,
    );
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).findRelated('foo', 1),
      /NotImplementedError: km-core-adapter\.findRelated/,
    );
  });

  it('surface — Test 5b: queryRelations is implemented and delegates to store.findRelations', async () => {
    // Stage 3 — `knowledge/session-facts.ts` needs every `contains` edge in one
    // read to walk hierarchy ancestry. It is a BULK read on purpose: looping
    // `queryIncomingRelations` over ~2,500 entities would scan ~17,000 edges
    // each time to answer what one scan answers.
    const calls: Array<Record<string, unknown>> = [];
    const store = new StubGraphKMStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).findRelations = async (filter: Record<string, unknown>) => {
      calls.push(filter);
      return [{ type: 'contains', from: 'parent-id', to: 'child-id' }];
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rels = await (adapter as any).queryRelations({ type: 'contains' });

    assert.deepEqual(calls, [{ type: 'contains' }], 'the filter must reach the store unchanged');
    assert.equal(rels.length, 1);
    assert.equal(rels[0].type, 'contains');
  });

  it('surface — Test 5c: an omitted filter reads every edge rather than none', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const store = new StubGraphKMStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).findRelations = async (filter: Record<string, unknown>) => {
      calls.push(filter);
      return [];
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (adapter as any).queryRelations();

    assert.deepEqual(calls, [{}], 'undefined must become an empty filter, not be forwarded as undefined');
  });
});

// ---------------------------------------------------------------------------
// Section 3: mergeAttributes behavior (used by wave-controller bypass — Task 2)
// ---------------------------------------------------------------------------

describe('km-core-adapter — mergeAttributes', () => {
  it('resolves nodeId (team:name) to EntityId via iterate scan, then delegates to store.mergeAttributes', async () => {
    const store = new StubGraphKMStore();
    const e = freshEntity('TranscriptAdapter', 'Detail');
    store.seed(e);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    const enrichedAttrs = { embedding: new Array(384).fill(0.5), role: 'core', enrichedContext: 'ctx' };
    await adapter.mergeAttributes('coding:TranscriptAdapter', enrichedAttrs);

    assert.equal(store.mergeAttributesCalls.length, 1);
    assert.equal(store.mergeAttributesCalls[0].id, e.id);
    // No field-stripping: embedding/role/enrichedContext passed through verbatim
    assert.deepEqual(store.mergeAttributesCalls[0].attrs, enrichedAttrs);
  });

  it('throws when the entity name does not resolve via findByName', async () => {
    const store = new StubGraphKMStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    await assert.rejects(
      adapter.mergeAttributes('coding:Missing', { embedding: [1, 2, 3] }),
      /not found/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Section 4: Wave-controller bypass rewire — Tests 6, 7, 8 (Task 2)
//
// We exercise only the bypass loop (NOT the full WaveController). The loop
// reads from a `currentEntities` array and calls either `graphDB.mergeAttributes`
// (legacy) or `kmCoreAdapter.mergeAttributes` (km-core). We stub both sides
// with the same shape and select via the feature flag.
// ---------------------------------------------------------------------------

interface BypassEntity {
  name: string;
  embedding?: number[];
  role?: string;
  enrichedContext?: string;
}

interface BypassDeps {
  team: string;
  graphDB: { mergeAttributes(nodeId: string, attrs: Record<string, unknown>): Promise<void> };
  kmCoreAdapter?: KmCoreAdapter;
}

/**
 * Mirrors wave-controller.ts:1361-1387. Lifted verbatim into a pure function
 * for testability — the production rewire (Task 2) preserves the same shape.
 */
async function runBypassLoop(deps: BypassDeps, currentEntities: BypassEntity[]): Promise<{ success: number; failed: number }> {
  let directWriteSuccess = 0;
  let directWriteFail = 0;
  for (const entity of currentEntities) {
    const enrichedAttrs: Record<string, unknown> = {};
    if (entity.embedding && entity.embedding.length > 0) enrichedAttrs.embedding = entity.embedding;
    if (entity.role) enrichedAttrs.role = entity.role;
    if (entity.enrichedContext) enrichedAttrs.enrichedContext = entity.enrichedContext;

    if (Object.keys(enrichedAttrs).length > 0) {
      try {
        const nodeId = `${deps.team}:${entity.name}`;
        if (deps.kmCoreAdapter) {
          await deps.kmCoreAdapter.mergeAttributes(nodeId, enrichedAttrs);
        } else {
          await deps.graphDB.mergeAttributes(nodeId, enrichedAttrs);
        }
        directWriteSuccess++;
      } catch {
        directWriteFail++;
      }
    }
  }
  return { success: directWriteSuccess, failed: directWriteFail };
}

describe('wave-controller bypass — phase 10 fix', () => {
  it('bypass phase 10 — Test 6: legacy path (flag off) calls graphDB.mergeAttributes', async () => {
    const calls: Array<{ nodeId: string; attrs: Record<string, unknown> }> = [];
    const legacyGraphDB = {
      async mergeAttributes(nodeId: string, attrs: Record<string, unknown>) {
        calls.push({ nodeId, attrs });
      },
    };

    const entities: BypassEntity[] = [
      { name: 'Foo', embedding: [0.1, 0.2], role: 'core' },
    ];

    const result = await runBypassLoop({ team: 'coding', graphDB: legacyGraphDB }, entities);
    assert.equal(result.success, 1);
    assert.equal(result.failed, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].nodeId, 'coding:Foo');
  });

  it('bypass phase 10 — Test 7: km-core path (flag on) calls kmCoreAdapter.mergeAttributes', async () => {
    const store = new StubGraphKMStore();
    store.seed(freshEntity('Foo', 'Detail'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    const legacyGraphDB = {
      mergeAttributes: async () => { throw new Error('legacy path must NOT be called when flag is on'); },
    };

    const entities: BypassEntity[] = [
      { name: 'Foo', embedding: new Array(384).fill(0.5), role: 'core', enrichedContext: 'ctx' },
    ];

    const result = await runBypassLoop(
      { team: 'coding', graphDB: legacyGraphDB, kmCoreAdapter: adapter },
      entities,
    );
    assert.equal(result.success, 1);
    assert.equal(result.failed, 0);
    assert.equal(store.mergeAttributesCalls.length, 1);
  });

  it('bypass phase 10 — Test 8: enriched fields pass through verbatim (no stripping)', async () => {
    const store = new StubGraphKMStore();
    store.seed(freshEntity('Foo', 'Detail'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    const embedding = new Array(384).fill(0).map((_, i) => i / 384);
    const entities: BypassEntity[] = [
      { name: 'Foo', embedding, role: 'core', enrichedContext: 'temporal-context-blob' },
    ];

    const legacyGraphDB = { mergeAttributes: async () => { throw new Error('unused'); } };

    await runBypassLoop({ team: 'coding', graphDB: legacyGraphDB, kmCoreAdapter: adapter }, entities);

    const call = store.mergeAttributesCalls[0];
    assert.deepEqual(call.attrs.embedding, embedding);
    assert.equal(call.attrs.role, 'core');
    assert.equal(call.attrs.enrichedContext, 'temporal-context-blob');
  });
});

// ---------------------------------------------------------------------------
// Section 6: storeEntity upserts instead of minting duplicates
//
// The orphan bug (2026-09-07): putEntity mints a fresh EntityId whenever `id`
// is absent, and storeEntity never supplied one — so every run created a
// SECOND node for an existing component, while storeRelationship resolved its
// endpoints by name and kept attaching edges to the FIRST one. The new nodes
// were born edgeless. `LiveLoggingSystem` ended up as four nodes, one with
// 13265 incoming edges and two with none.
// ---------------------------------------------------------------------------

/** Same name, distinct id and creation time — what a second run used to produce. */
function dupEntity(name: string, klass: string, id: string, createdAt: string): StubEntity {
  return {
    ...freshEntity(name, klass),
    id,
    createdAt,
    updatedAt: createdAt,
  };
}

describe('km-core-adapter — storeEntity upsert', () => {
  it('re-writes the EXISTING node instead of minting a second one', async () => {
    const store = new StubGraphKMStore();
    store.seed(freshEntity('LiveLoggingSystem', 'Component'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    await adapter.storeEntity(
      { name: 'LiveLoggingSystem', entityType: 'Component', observations: ['re-analysed'] },
      { team: 'coding' },
    );

    assert.equal(store.putEntityCalls.length, 1);
    assert.equal(
      store.putEntityArgs[0].id,
      freshEntity('LiveLoggingSystem', 'Component').id,
      'must reuse the existing EntityId — a minted one is a duplicate node',
    );
  });

  it('carries createdAt forward so the confirm-write keeps the real creation date', async () => {
    const store = new StubGraphKMStore();
    const original = freshEntity('KnowledgeManagement', 'Component');
    store.seed(original);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    await adapter.storeEntity(
      { name: 'KnowledgeManagement', entityType: 'Component', observations: ['x'] },
      { team: 'coding' },
    );

    // putEntity stamps `createdAt: e.createdAt ?? now`, and mergeNode would
    // overwrite the stored date with the time of this run.
    assert.equal(store.putEntityArgs[0].createdAt, original.createdAt);
  });

  it('still mints for a name the graph has never seen', async () => {
    const store = new StubGraphKMStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    await adapter.storeEntity(
      { name: 'BrandNewThing', entityType: 'SubComponent', observations: ['x'] },
      { team: 'coding' },
    );

    assert.equal(store.putEntityCalls.length, 1);
    assert.equal(store.putEntityArgs[0].id, undefined, 'no id ⇒ the store mints one');
  });

  it('does not bind onto a different-typed entity that happens to share the name', async () => {
    const store = new StubGraphKMStore();
    store.seed(freshEntity('Pipeline', 'Insight'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    await adapter.storeEntity(
      { name: 'Pipeline', entityType: 'Component', observations: ['x'] },
      { team: 'coding' },
    );

    assert.equal(store.putEntityArgs[0].id, undefined, 'an Insight is not this Component');
  });
});

describe('km-core-adapter — a fresh run must not undo stage 5', () => {
  /** A parent whose description the stage-5 synthesis pass wrote. */
  function synthesisedParent(name: string, klass: string): StubEntity {
    const e = freshEntity(name, klass);
    e.description = `${name} coordinates its children into one subsystem.`;
    e.metadata = {
      ...e.metadata,
      synthesizedBy: 'parent-description-synthesis',
      rolledUpAt: '2026-09-21T06:38:00.000Z',
      rollUpOf: 4,
    };
    return e;
  }

  it('keeps a synthesised parent description instead of the observation join', async () => {
    const store = new StubGraphKMStore();
    const parent = synthesisedParent('KnowledgeManagement', 'Component');
    store.seed(parent);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    await adapter.storeEntity(
      {
        name: 'KnowledgeManagement',
        entityType: 'Component',
        observations: ['The GraphifyGraph reader loads graph.json.', 'A second note.'],
      },
      { team: 'coding' },
    );

    assert.equal(
      store.putEntityArgs[0].description,
      parent.description,
      'the observation join must not overwrite a synthesised parent description',
    );
  });

  it('stashes the run observations rather than dropping them', async () => {
    const store = new StubGraphKMStore();
    store.seed(synthesisedParent('KnowledgeManagement', 'Component'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    const observations = ['The GraphifyGraph reader loads graph.json.', 'A second note.'];
    await adapter.storeEntity(
      { name: 'KnowledgeManagement', entityType: 'Component', observations },
      { team: 'coding' },
    );

    const meta = store.putEntityArgs[0].metadata as Record<string, unknown>;
    assert.deepEqual(
      meta.observations,
      observations,
      'preserving the description must not silently discard the run output',
    );
  });

  it('an EXPLICIT description still wins — only the fabricated join is refused', async () => {
    const store = new StubGraphKMStore();
    store.seed(synthesisedParent('KnowledgeManagement', 'Component'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    await adapter.storeEntity(
      {
        name: 'KnowledgeManagement',
        entityType: 'Component',
        description: 'A deliberate restatement.',
        observations: ['ignored'],
      },
      { team: 'coding' },
    );

    assert.equal(store.putEntityArgs[0].description, 'A deliberate restatement.');
  });

  it('leaves a leaf alone — no stamp means the join is still the right answer', async () => {
    const store = new StubGraphKMStore();
    store.seed(freshEntity('GraphifyGraphReader', 'Detail'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    await adapter.storeEntity(
      { name: 'GraphifyGraphReader', entityType: 'Detail', observations: ['first', 'second'] },
      { team: 'coding' },
    );

    assert.equal(store.putEntityArgs[0].description, 'first\n\nsecond');
    const meta = store.putEntityArgs[0].metadata as Record<string, unknown>;
    assert.equal(meta.observations, undefined, 'no stash on the normal path');
  });

  it('does not preserve when the stored row was never synthesised', async () => {
    const store = new StubGraphKMStore();
    store.seed(freshEntity('LoggingModule', 'SubComponent'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    await adapter.storeEntity(
      { name: 'LoggingModule', entityType: 'SubComponent', observations: ['fresh'] },
      { team: 'coding' },
    );

    assert.equal(store.putEntityArgs[0].description, 'fresh');
  });
});

describe('km-core-adapter — name resolution is deterministic', () => {
  it('binds to the OLDEST duplicate, which is where the edges already are', async () => {
    const store = new StubGraphKMStore();
    // Deliberately seeded newest-first so "first match in iteration order"
    // would pick the wrong one.
    store.seed(dupEntity('Ontology', 'Component', 'id-new', '2026-09-07T17:40:00.000Z'));
    store.seed(dupEntity('Ontology', 'Component', 'id-old', '2026-03-07T12:38:00.000Z'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    const found = await adapter.getEntity('Ontology', 'coding');
    assert.equal(found?.id, 'id-old');
  });

  it('puts an edge on the same node storeEntity writes to', async () => {
    // The two used to disagree: storeEntity minted a new node, storeRelationship
    // resolved by name to the old one, and the new node stayed edgeless.
    const store = new StubGraphKMStore();
    store.seed(dupEntity('Coding', 'Project', 'proj-old', '2026-03-07T12:38:00.000Z'));
    store.seed(dupEntity('Insights', 'Component', 'comp-new', '2026-09-07T17:40:00.000Z'));
    store.seed(dupEntity('Insights', 'Component', 'comp-old', '2026-05-01T00:00:00.000Z'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createKmCoreAdapter({ store: store as any, team: 'coding' });

    await adapter.storeEntity(
      { name: 'Insights', entityType: 'Component', observations: ['x'] },
      { team: 'coding' },
    );
    await adapter.storeRelationship('Coding', 'Insights', 'contains', {});

    const written = store.putEntityCalls[0].id;
    const edge = store.addRelationCalls[0];
    assert.equal(written, 'comp-old');
    assert.equal(edge.to, written, 'the edge must land on the node just written');
    assert.equal(edge.from, 'proj-old');
  });
});

// ---------------------------------------------------------------------------
// Section 6: hierarchy metadata + the shallow-merge clobber
// ---------------------------------------------------------------------------

/** freshEntity with a caller-chosen metadata object. */
function withMetadata(
  name: string,
  klass: string,
  metadata: Record<string, unknown>,
): StubEntity {
  return { ...freshEntity(name, klass), metadata };
}

describe('km-core-adapter — hierarchy metadata', () => {
  const mk = (store: StubGraphKMStore) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createKmCoreAdapter({ store: store as any, team: 'coding' });

  it('stamps parentEntityName from source.parentId', async () => {
    const store = new StubGraphKMStore();
    await mk(store).storeEntity(
      { name: 'RedactionEngine', entityType: 'SubComponent', parentId: 'LiveLoggingSystem' },
      { team: 'coding' },
    );
    const md = store.putEntityArgs[0].metadata as Record<string, unknown>;
    assert.equal(md.parentEntityName, 'LiveLoggingSystem');
  });

  it('stamps hierarchyLevel from source.level', async () => {
    const store = new StubGraphKMStore();
    await mk(store).storeEntity(
      { name: 'RedactionEngine', entityType: 'SubComponent', level: 2 },
      { team: 'coding' },
    );
    const md = store.putEntityArgs[0].metadata as Record<string, unknown>;
    assert.equal(md.hierarchyLevel, 2);
  });

  it('derives isScaffoldNode from the level — true at L2, false at L3', async () => {
    const l2 = new StubGraphKMStore();
    await mk(l2).storeEntity({ name: 'A', entityType: 'SubComponent', level: 2 }, { team: 'coding' });
    assert.equal((l2.putEntityArgs[0].metadata as Record<string, unknown>).isScaffoldNode, true);

    const l3 = new StubGraphKMStore();
    await mk(l3).storeEntity({ name: 'B', entityType: 'Detail', level: 3 }, { team: 'coding' });
    assert.equal((l3.putEntityArgs[0].metadata as Record<string, unknown>).isScaffoldNode, false);
  });

  it('omits isScaffoldNode entirely when no level is supplied', async () => {
    // Guards the non-wave callers (tools.ts handleCreateUkbEntity, renameEntity).
    // Writing the derivation as `(source.level ?? 3) < 3` would evaluate to
    // `false` here and invent a fabricated fact for every one of them.
    const store = new StubGraphKMStore();
    await mk(store).storeEntity({ name: 'HandMade', entityType: 'Detail' }, { team: 'coding' });
    const md = store.putEntityArgs[0].metadata as Record<string, unknown>;
    assert.ok(!('isScaffoldNode' in md), 'must not invent a scaffold flag');
    assert.ok(!('hierarchyLevel' in md));
  });

  it('sourceMetadata.parentEntityName wins over source.parentId', async () => {
    const store = new StubGraphKMStore();
    await mk(store).storeEntity(
      {
        name: 'C',
        entityType: 'SubComponent',
        parentId: 'LooseField',
        metadata: { parentEntityName: 'CanonicalMapperStamp' },
      },
      { team: 'coding' },
    );
    const md = store.putEntityArgs[0].metadata as Record<string, unknown>;
    assert.equal(md.parentEntityName, 'CanonicalMapperStamp');
  });

  it('an upsert PRESERVES metadata a previous write stamped', async () => {
    // The wave-4 regression, and the reason change A needed the
    // read-modify-write: putEntity ends in graph.mergeNode, a SHALLOW merge, so
    // a partial `metadata` object replaced the stored one wholesale. Wave 4
    // passes only {validated_file_path, has_insight_document} and was thereby
    // erasing everything waves 1-3 wrote. Measured on 2026-09-20: 181
    // insight-bearing rows, ZERO of which still had parentEntityName.
    const store = new StubGraphKMStore();
    store.seed(
      withMetadata('MultiUserFileManager', 'SubComponent', {
        parentEntityName: 'LiveLoggingSystem',
        hierarchyLevel: 2,
        ontology: { ontologyClass: 'SubComponent' },
        source: 'wave-analysis',
        subsystem: 'wave-analysis',
      }),
    );

    await mk(store).storeEntity(
      {
        name: 'MultiUserFileManager',
        entityType: 'SubComponent',
        metadata: { validated_file_path: '/x.md', has_insight_document: true },
      },
      { team: 'coding' },
    );

    const md = store.putEntityArgs[0].metadata as Record<string, unknown>;
    assert.equal(md.parentEntityName, 'LiveLoggingSystem', 'wave-4 must not erase the parent');
    assert.equal(md.hierarchyLevel, 2);
    assert.equal(md.source, 'wave-analysis');
    assert.ok(md.ontology, 'the ontology block must survive an insight stamp');
    assert.equal(md.validated_file_path, '/x.md', 'and the new keys still land');
    assert.equal(md.has_insight_document, true);
  });

  it('still binds the EXISTING id when hierarchy fields are present', async () => {
    // Non-regression for the upsert path with the new stamps in play.
    const store = new StubGraphKMStore();
    store.seed(freshEntity('LiveLoggingSystem', 'Component'));
    await mk(store).storeEntity(
      { name: 'LiveLoggingSystem', entityType: 'Component', parentId: 'Coding', level: 1 },
      { team: 'coding' },
    );
    assert.equal(store.putEntityCalls.length, 1);
    assert.equal(
      store.putEntityArgs[0].id,
      freshEntity('LiveLoggingSystem', 'Component').id,
      'must reuse the existing EntityId',
    );
  });
});
