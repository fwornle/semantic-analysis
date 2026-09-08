/**
 * km-core strangler adapter — Phase 42 Plan 01.
 *
 * Exposes the hot read/write surface that B's existing consumers
 * (`persistence-agent.ts`, `wave-controller.ts`, `content-validation-agent.ts`,
 * `tools.ts`) call on `GraphDatabaseService` / `GraphDatabaseAdapter`, but
 * routes the calls through km-core's canonical `GraphKMStore` instead.
 *
 * The `KM_CORE_PERSISTENCE` feature flag was deleted in Phase 42 Plan 07
 * Phase B1; this adapter is now the unconditional persistence backend in
 * wave-controller. GraphDatabaseService is still in tree (deferred), but
 * wave-controller no longer reads from it for the persist path.
 *
 * Surface (RESEARCH §3 — caller heat map of GraphDatabaseService methods):
 *
 *   HOT (non-zero callers in src/ — adapter must implement):
 *     - mergeAttributes(nodeId, attrs)     ← Phase 10 fix anchor (wave-controller:1373)
 *     - queryEntities(options)             ← 13 callers
 *     - storeEntity(entity, opts)          ←  6 callers
 *     - storeRelationship(from, to, type)  ←  4 callers
 *     - getEntity(name, team)              ←  4 callers
 *     - deleteEntity(name, team, opts)     ←  6 callers
 *
 *   COLD (zero callers in src/ — adapter throws NotImplementedError):
 *     - queryRelations
 *     - queryByOntologyClass
 *     - findRelated
 *
 * Entity-shape translation follows the D-54 mapping table
 * (.planning/phases/42-offline-ukb-migration-b/42-RESEARCH.md §4).
 *
 * NOTE on the Phase 39 CF-D37 ratification: `legacyId` lives on the
 * top-level Entity (NOT inside metadata). The adapter respects this.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  isProject,
  type Entity,
  type Relation,
  type GraphKMStore,
  type BatchOp,
  type ProvenanceStamp,
  type Project,
} from '@fwornle/km-core';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface KmCoreAdapter {
  /**
   * Phase 42.2 Plan 04 — legacy compatibility surface.
   *
   * The legacy `GraphDatabaseAdapter` exposed `.initialize()` (which opened
   * the LevelDB store) and `.initialized` (a boolean flag). km-core's
   * `GraphKMStore` opens the store at construction time, so `initialize`
   * is a no-op and `initialized` always returns true. The members are
   * retained for drop-in compatibility with the rewired consumer call sites
   * in coordinator.ts / tools.ts / content-validation-agent.ts.
   */
  initialize(): Promise<void>;
  readonly initialized: boolean;

  /**
   * Phase 42.2 Plan 04 — legacy compatibility surface.
   * Legacy `GraphDatabaseAdapter.close()` closed the LevelDB handle. km-core
   * stores are managed by the caller (the wave-controller / tools handler
   * owns the GraphKMStore lifecycle); this method is a no-op forwarded to
   * the underlying store if the store exposes one. Retained for drop-in
   * compatibility.
   */
  close(): Promise<void>;

  /**
   * Operator-enriched bulk write — phase 10 anchor.
   *
   * `nodeId` follows B's existing `${team}:${entityName}` convention. The
   * adapter looks the entity up via `store.findByName(name)` to resolve the
   * EntityId, then delegates to `store.mergeAttributes(id, attrs)` (which
   * itself calls Graphology's `mergeNodeAttributes` — see km-core
   * GraphKMStore.ts:854).
   *
   * Throws if the entity is not found in the store (matches km-core's
   * existing `Node ${id} not found in graph` contract).
   */
  mergeAttributes(nodeId: string, attrs: Record<string, unknown>): Promise<void>;

  /**
   * Filtered list of entities. Iterates the store and applies filters.
   * When only `ontologyClass` is set, the adapter takes the fast path via
   * `store.findByOntologyClass`.
   */
  queryEntities(options?: QueryEntitiesOptions): Promise<Entity[]>;

  /**
   * Write a new entity (or upsert by id when caller supplies one). Translates
   * B's SharedMemoryEntity-ish shape into the canonical km-core Entity per
   * D-54. Returns `{ id }` matching B's existing return contract.
   *
   * Phase 57 D-04 — `options.project` (optional) carries the closed-set
   * project tag. When set and valid per `isProject()`, it is stamped into
   * `metadata.project` as a defence-in-depth dual stamp alongside the
   * canonical-mapper's primary stamp.
   */
  storeEntity(
    entity: Record<string, unknown>,
    options: { team: string; project?: Project | string },
  ): Promise<{ id: string }>;

  /**
   * Add a relation by entity-name (B's convention). Resolves both names to
   * EntityIds via `store.findByName` then calls `store.addRelation`.
   */
  storeRelationship(
    fromName: string,
    toName: string,
    type: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;

  /**
   * Read one entity by name. The `team` argument is currently ignored —
   * km-core is single-tenant per store instance and Plan 5 migrates the
   * team-tagging into `metadata.team`.
   */
  getEntity(name: string, team: string): Promise<Entity | undefined>;

  /**
   * Phase 42.1 INT-02 — list incoming relations for an entity (by name).
   *
   * Resolves `toName` to an EntityId via the name-scan + delegates to
   * `store.findRelations({ to })`. Returns [] if the entity is not found
   * (matches B's tolerant no-op pattern — the caller will treat absence as
   * "no anchor known, proceed with insertion under storeRelationship try/catch").
   *
   * Used by wave-controller's post-sweep anchor pass to detect entities that
   * already carry an incoming contains/parent-child edge from a previous
   * wave-analysis run (Layer (b) of the two-layer idempotency check).
   */
  queryIncomingRelations(toName: string): Promise<Relation[]>;

  /**
   * Delete one entity by name. If the entity is not found, returns silently
   * (matches B's no-op behavior at GraphDatabaseService.js:513-597).
   */
  deleteEntity(name: string, team: string, options?: Record<string, unknown>): Promise<void>;

  /**
   * Phase 42.2 Plan 04 — port of the legacy
   * `PersistenceAgent.renameEntity(...)` semantics, decomposed into km-core
   * primitives. Order honors threat model T-42.2-04-01 (get → store(new) →
   * delete(old) — new exists before old is removed so no window of absence).
   *
   * Migrates entity files (insight markdown, PUML, PNG) when migrateFiles
   * is true (default). File migration is best-effort and matches the legacy
   * helper's behavior at persistence-agent.ts:3175-3232.
   */
  renameEntity(params: {
    oldName: string;
    newName: string;
    team: string;
    migrateFiles?: boolean;
    insightsDir?: string;
  }): Promise<{
    success: boolean;
    migratedFiles: string[];
    deletedFiles: string[];
    details: string;
  }>;

  /**
   * Phase 42.2 Plan 04 — port of the legacy
   * `PersistenceAgent.updateEntityObservations(...)` semantics. Loads the
   * entity, filters out observations matched by `removeObservations`
   * (substring match for flexibility, matching legacy behavior),
   * appends `newObservations`, and writes back via `mergeAttributes`.
   */
  updateEntityObservations(params: {
    entityName: string;
    team: string;
    removeObservations: string[];
    newObservations?: Array<string | { content: string; type?: string; metadata?: Record<string, unknown> }>;
  }): Promise<{
    success: boolean;
    updatedEntity: Entity | null;
    removedCount: number;
    addedCount: number;
    details: string;
  }>;

  // Cold-path stubs — throw NotImplementedError. Fill in when a caller appears.
  queryRelations(options?: Record<string, unknown>): Promise<never>;
  queryByOntologyClass(options?: Record<string, unknown>): Promise<never>;
  findRelated(entityName: string, depth?: number, filter?: unknown): Promise<never>;
}

export interface QueryEntitiesOptions {
  team?: string;
  searchTerm?: string;
  ontologyClass?: string;
  entityType?: string;
  limit?: number;
  offset?: number;
}

export interface CreateKmCoreAdapterOptions {
  store: GraphKMStore;
  team: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a `KmCoreAdapter` bound to a `GraphKMStore` instance.
 *
 * The `team` argument is captured for storeEntity / mergeAttributes
 * provenance stamping and for the legacy `${team}:${name}` nodeId
 * convention. km-core's store is single-tenant per instance — Plan 5
 * migrates team-tagging into `metadata.team`.
 */
export function createKmCoreAdapter(opts: CreateKmCoreAdapterOptions): KmCoreAdapter {
  const { store, team } = opts;

  /** Migration provenance stamp for storeEntity writes. */
  const provenance = (): ProvenanceStamp => ({
    provider: 'phase-42-strangler-adapter',
    model: 'b-to-km-core',
    runId: `wave-analysis-${team}`,
    timestamp: new Date().toISOString(),
  });

  /**
   * Resolve entity by name via async iteration (km-core's GraphKMStore does
   * not expose a `findByName` — iterate(filter) is the documented lookup
   * path per D-18; this scans linearly and is fine for B's small graphs).
   *
   * Plan 5+ can add a name → id index in km-core if profiling shows this
   * is a hot path. For Plan 1 the wave-controller bypass loop runs
   * <1000x per `ukb full` (one merge per entity), so O(n) per call is OK.
   */
  async function findEntityByName(
    name: string,
    entityType?: string,
  ): Promise<Entity | undefined> {
    // Phase 42.2 Plan 06 bugfix — pass {includeSuperseded: true} so we see
    // the Phase 42-05 migrated cohort whose `validUntil: null` would
    // otherwise cause km-core's default isActive filter to drop them
    // (`new Date(null).getTime() === 0` is < now ⇒ isActive=false).
    // Without this, the anchor pass's `storeRelationship('Coding', …)` call
    // throws "from-entity 'Coding' not found" because the migrated Coding
    // Project entity has `validUntil: null`, and every wave-emitted
    // Component/SubComponent gets orphaned. Caught silently by the anchor
    // pass try/catch → SC#6 fails with 18+ orphans. See augment-team-field-
    // 42.2.mjs:163 for the same pattern.
    //
    // OLDEST WINS, and it must: this used to return the first name match in
    // iteration order, which was unspecified. With duplicate nodes in the
    // graph that made edge endpoints non-deterministic — storeRelationship
    // could attach an edge to one duplicate while storeEntity had just
    // written another. The oldest node is the one carrying the accumulated
    // edges, so binding to it keeps writes and edges on the same node.
    // `entityType`, when supplied, is preferred but not required: a name
    // shared by two different types must not bind a Component's write onto
    // an Insight that happens to share its name.
    let best: Entity | undefined;
    let bestTypeMatch = false;
    for await (const e of store.iterate(undefined, { includeSuperseded: true })) {
      if (e.name !== name) continue;
      const typeMatch = entityType === undefined || e.entityType === entityType;
      if (best === undefined) {
        best = e;
        bestTypeMatch = typeMatch;
        continue;
      }
      // A type match always beats a non-match; among equals, oldest wins.
      if (typeMatch && !bestTypeMatch) {
        best = e;
        bestTypeMatch = true;
      } else if (typeMatch === bestTypeMatch && isOlder(e, best)) {
        best = e;
      }
    }
    if (entityType !== undefined && best !== undefined && !bestTypeMatch) {
      // Only a different-typed node shares this name — not our entity.
      return undefined;
    }
    return best;
  }

  /** Creation order, falling back to the time-ordered id when createdAt is absent. */
  function isOlder(a: Entity, b: Entity): boolean {
    const at = a.createdAt ?? '';
    const bt = b.createdAt ?? '';
    if (at !== bt) return at < bt;
    return String(a.id) < String(b.id);
  }

  /** Resolve `${team}:${name}` → Entity by stripping the team prefix. */
  async function resolveByNodeId(nodeId: string): Promise<Entity | undefined> {
    const name = nodeId.includes(':') ? nodeId.split(':').slice(1).join(':') : nodeId;
    return findEntityByName(name);
  }

  /**
   * File-rename helper for `renameEntity` — ports the legacy
   * `PersistenceAgent.migrateEntityFiles(...)` logic to a free function.
   * Best-effort; returns {migrated, deleted} arrays.
   */
  function migrateLegacyEntityFiles(
    oldName: string,
    newName: string,
    insightsDir: string,
  ): { migrated: string[]; deleted: string[] } {
    const result = { migrated: [] as string[], deleted: [] as string[] };
    const pumlDir = path.join(insightsDir, 'puml');
    const imagesDir = path.join(insightsDir, 'images');

    const toKebabCase = (s: string): string =>
      s
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/[\s_]+/g, '-')
        .toLowerCase();

    const oldKebab = toKebabCase(oldName);
    const newKebab = toKebabCase(newName);

    // Migrate insight markdown
    const oldInsightPath = path.join(insightsDir, `${oldName}.md`);
    const newInsightPath = path.join(insightsDir, `${newName}.md`);
    if (fs.existsSync(oldInsightPath)) {
      fs.renameSync(oldInsightPath, newInsightPath);
      result.migrated.push(newInsightPath);
      result.deleted.push(oldInsightPath);
    }

    // Migrate PUML files (kebab-prefix match)
    if (fs.existsSync(pumlDir)) {
      const pumlFiles = fs
        .readdirSync(pumlDir)
        .filter((f) => f.startsWith(`${oldKebab}-`));
      for (const f of pumlFiles) {
        const oldPath = path.join(pumlDir, f);
        const newPath = path.join(pumlDir, f.replace(oldKebab, newKebab));
        fs.renameSync(oldPath, newPath);
        result.migrated.push(newPath);
        result.deleted.push(oldPath);
      }
    }

    // Migrate PNG files (kebab-prefix match)
    if (fs.existsSync(imagesDir)) {
      const pngFiles = fs
        .readdirSync(imagesDir)
        .filter((f) => f.startsWith(`${oldKebab}-`));
      for (const f of pngFiles) {
        const oldPath = path.join(imagesDir, f);
        const newPath = path.join(imagesDir, f.replace(oldKebab, newKebab));
        fs.renameSync(oldPath, newPath);
        result.migrated.push(newPath);
        result.deleted.push(oldPath);
      }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // initialize / close / initialized — Phase 42.2 Plan 04 compat shims
  //
  // The legacy GraphDatabaseAdapter exposed these for the LevelDB handle
  // lifecycle. km-core's GraphKMStore opens the store at construction time,
  // so initialize is a no-op and initialized is always true. close forwards
  // to store.close() if the store exposes one (it currently does not as of
  // km-core 0.1.x, so close is also effectively a no-op).
  // -------------------------------------------------------------------------

  async function initialize(): Promise<void> {
    // No-op — km-core opens at construction time.
  }

  async function close(): Promise<void> {
    // No-op — caller owns store lifecycle.
    const maybeClose = (store as unknown as { close?: () => Promise<void> }).close;
    if (typeof maybeClose === 'function') {
      await maybeClose.call(store);
    }
  }

  // -------------------------------------------------------------------------
  // mergeAttributes — phase 10 anchor
  // -------------------------------------------------------------------------

  async function mergeAttributes(nodeId: string, attrs: Record<string, unknown>): Promise<void> {
    const entity = await resolveByNodeId(nodeId);
    if (!entity) {
      throw new Error(`km-core-adapter.mergeAttributes: entity not found for nodeId='${nodeId}'`);
    }
    await store.mergeAttributes(entity.id, attrs as Partial<Entity>);
  }

  // -------------------------------------------------------------------------
  // queryEntities — fast path via findByOntologyClass when applicable
  // -------------------------------------------------------------------------

  async function queryEntities(options: QueryEntitiesOptions = {}): Promise<Entity[]> {
    const { searchTerm, ontologyClass, entityType, limit, offset } = options;

    // Fast path: a class filter alone — defer to km-core's class index
    const classFilter = ontologyClass ?? entityType;
    let candidates: Entity[];
    if (classFilter && !searchTerm) {
      candidates = await store.findByOntologyClass(classFilter);
    } else {
      candidates = [];
      for await (const e of store.iterate()) candidates.push(e);
    }

    // Apply remaining filters
    const filtered = candidates.filter((e) => {
      if (classFilter && e.ontologyClass !== classFilter && e.entityType !== classFilter) return false;
      if (searchTerm) {
        const needle = searchTerm.toLowerCase();
        const hay = `${e.name} ${e.description ?? ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });

    const start = offset ?? 0;
    const end = typeof limit === 'number' ? start + limit : undefined;
    return filtered.slice(start, end);
  }

  // -------------------------------------------------------------------------
  // storeEntity — SharedMemoryEntity → canonical Entity per D-54
  // -------------------------------------------------------------------------

  async function storeEntity(
    source: Record<string, unknown>,
    options: { team: string; project?: Project | string },
  ): Promise<{ id: string }> {
    const name = String(source.name ?? '');
    if (!name) throw new Error('km-core-adapter.storeEntity: entity.name is required');

    const entityType = String(source.entityType ?? source.type ?? 'Unclassified');
    const ontologyClass = String(source.ontologyClass ?? entityType);

    // ID handling: existing legacy id → top-level legacyId.id. The canonical
    // EntityId is minted by km-core's putEntity (D-10) and returned from
    // the call. Per Phase 39 CF-D37, legacyId lives at the top level.
    //
    // Phase 42.2 Plan 06 follow-up — fall back to source.name when source.id
    // is absent. Wave-controller's persistWithKmCore passes raw KGEntities
    // without an explicit `id` field; previously this left legacyId undefined,
    // which caused those entities to appear in general.json with
    // `legacyId: null` (ghost entities — visible to graphology export but not
    // to km-core iterate's isActive filter when validUntil is set). Mirrors
    // canonical-mapper.ts:192-194 which uses `raw.id ?? raw.name`. The
    // `validFrom` stamp below ensures isActive returns true for these too.
    const incomingId = source.id ? String(source.id) : (name || undefined);
    const legacyId = incomingId ? ({ system: 'B' as const, id: incomingId }) : undefined;

    // Description: prefer explicit description; else join observations.
    let description = '';
    if (typeof source.description === 'string') {
      description = source.description;
    } else if (Array.isArray(source.observations)) {
      description = (source.observations as unknown[])
        .map((o) => (typeof o === 'string' ? o : (o as { content?: unknown })?.content ?? ''))
        .filter(Boolean)
        .join('\n\n');
    }

    const now = new Date().toISOString();
    const sourceMetadata = (typeof source.metadata === 'object' && source.metadata !== null)
      ? (source.metadata as Record<string, unknown>)
      : {};

    // Phase 42.2 Plan 02 Gap 4 — explicitly merge `team` from the options
    // bag into the metadata literal. Defence-in-depth: the underscore-prefixed
    // `_options` previously silently dropped the team value that wave-controller
    // was already passing (`{ team: this.team }` at wave-controller.ts:2381).
    // Forensics report `report-42.2-00-canonical-emit.md` §1.3 paragraph 2
    // documents this leak; we close it here in addition to the canonical-mapper
    // stamp (Gap 1) so both paths into km-core carry team consistently.
    const teamFromOptions =
      typeof options.team === 'string' && options.team.length > 0
        ? options.team
        : undefined;

    // Phase 57 D-04 — defence-in-depth dual stamp for the closed-set
    // `metadata.project` tag. Mirrors the Gap 4 team dual-stamp above:
    // the canonical-mapper has the PRIMARY stamp; here at the actual
    // putEntity call site we also stamp project so any writer path that
    // bypasses canonical-mapper (e.g., renameEntity / direct ad-hoc calls)
    // still emits the project tag. `isProject()` from km-core is the
    // closed-set typeguard (D-03). Defaulting to 'coding' is intentionally
    // NOT done here — the canonical-mapper / wave-controller boundary owns
    // the default; stamping a hardcoded value here would silently mask
    // upstream bugs (per Plan 57-03 Task 2 action).
    const projectFromOptions = isProject(options.project) ? options.project : undefined;

    // UPSERT, not insert. putEntity mints a fresh EntityId whenever `id` is
    // absent (GraphKMStore.putEntity: `else { id = mintEntityId(); }`), and
    // this function never supplied one — so every re-run minted a SECOND node
    // for a component that already existed. Meanwhile storeRelationship
    // resolves its endpoints by NAME, so the contains edges kept landing on
    // the pre-existing node and each run's freshly minted nodes were born
    // edgeless. That is where the orphans came from: on 2026-09-07,
    // `LiveLoggingSystem` existed as four nodes, one with 13265 incoming
    // edges and two with none, and 155 of 163 orphans shared a name with
    // another node.
    //
    // Passing the existing id makes this a CONFIRM-WRITE: km-core keeps
    // `createdBy`, bumps `confirmationCount`, and Graphology's mergeNode
    // updates the attributes we pass while preserving the node's edges. The
    // supersession branch cannot fire here — it is guarded by `!existing` AND
    // we never set `supersedes`.
    const existingEntity = await findEntityByName(name, entityType);

    // Build the putEntity payload. On the insert path the store mints the id
    // and stamps createdAt/updatedAt (D-31/D-32); on the upsert path we carry
    // the original createdAt forward, because putEntity stamps
    // `createdAt: e.createdAt ?? now` and mergeNode would otherwise overwrite
    // the real creation date with the time of the latest run.
    const entity: Partial<Entity> & { name: string; entityType: string } = {
      ...(existingEntity
        ? { id: existingEntity.id, createdAt: existingEntity.createdAt }
        : {}),
      name,
      entityType,
      ontologyClass,
      layer: 'evidence',
      description,
      metadata: {
        ...sourceMetadata,
        subsystem: 'wave-analysis',
        // Gap 4: prefer team from sourceMetadata when present (the
        // canonical-mapper Gap 1 stamp), else fall back to the options bag.
        ...(typeof (sourceMetadata as { team?: unknown }).team === 'string' &&
        ((sourceMetadata as { team?: string }).team?.length ?? 0) > 0
          ? { team: (sourceMetadata as { team: string }).team }
          : teamFromOptions !== undefined
          ? { team: teamFromOptions }
          : {}),
        // Phase 57 D-04 — defence-in-depth project dual-stamp ternary.
        // Prefer sourceMetadata.project (canonical-mapper primary stamp from
        // Task 1) when set AND valid per isProject(); fall back to the
        // options bag's project (also isProject-gated above); else no-op.
        // Mirrors the team ternary directly above so team and project both
        // appear in the merged metadata whenever both are supplied. Closed-
        // set typeguard means a misspelled project ('codeing') is silently
        // dropped here — surfaces upstream stamping bugs at backfill grep
        // time rather than letting bad data flow into the export.
        ...(isProject((sourceMetadata as { project?: unknown }).project)
          ? { project: (sourceMetadata as { project: string }).project }
          : projectFromOptions !== undefined
          ? { project: projectFromOptions }
          : {}),
        ...(typeof source.significance !== 'undefined' ? { significance: source.significance } : {}),
        ...(typeof source.source !== 'undefined' ? { source: source.source } : {}),
        // Operator-enriched fields ride along on metadata until Plan 5
        // teaches consumers to read them from top-level Entity:
        ...(typeof (source as { embedding?: unknown }).embedding !== 'undefined'
          ? { embedding: (source as { embedding?: unknown }).embedding }
          : {}),
        ...(typeof (source as { role?: unknown }).role !== 'undefined'
          ? { role: (source as { role?: unknown }).role }
          : {}),
        ...(typeof (source as { enrichedContext?: unknown }).enrichedContext !== 'undefined'
          ? { enrichedContext: (source as { enrichedContext?: unknown }).enrichedContext }
          : {}),
      },
      validFrom: now,
      ...(legacyId ? { legacyId } : {}),
    };

    const mintedId = await store.putEntity(entity, { provenance: provenance() });
    return { id: String(mintedId) };
  }

  // -------------------------------------------------------------------------
  // storeRelationship — name-to-name → id-to-id
  // -------------------------------------------------------------------------

  async function storeRelationship(
    fromName: string,
    toName: string,
    type: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const [from, to] = await Promise.all([
      findEntityByName(fromName),
      findEntityByName(toName),
    ]);
    if (!from) {
      throw new Error(`km-core-adapter.storeRelationship: from-entity '${fromName}' not found`);
    }
    if (!to) {
      throw new Error(`km-core-adapter.storeRelationship: to-entity '${toName}' not found`);
    }
    const relation: Relation = {
      type,
      from: from.id,
      to: to.id,
      metadata,
    } as Relation;
    await store.addRelation(relation);
  }

  // -------------------------------------------------------------------------
  // getEntity / deleteEntity
  // -------------------------------------------------------------------------

  async function getEntity(name: string, _team: string): Promise<Entity | undefined> {
    return findEntityByName(name);
  }

  async function deleteEntity(
    name: string,
    _team: string,
    _options: Record<string, unknown> = {},
  ): Promise<void> {
    const entity = await findEntityByName(name);
    if (!entity) {
      // Mirrors B's no-op behavior at GraphDatabaseService.js:513-597
      return;
    }
    const ops: BatchOp[] = [{ type: 'deleteEntity', id: entity.id }];
    await store.batch(ops);
  }

  // -------------------------------------------------------------------------
  // renameEntity — Phase 42.2 Plan 04
  // -------------------------------------------------------------------------

  async function renameEntity(params: {
    oldName: string;
    newName: string;
    team: string;
    migrateFiles?: boolean;
    insightsDir?: string;
  }): Promise<{
    success: boolean;
    migratedFiles: string[];
    deletedFiles: string[];
    details: string;
  }> {
    const migrateFiles = params.migrateFiles ?? true;
    const result = {
      success: false,
      migratedFiles: [] as string[],
      deletedFiles: [] as string[],
      details: '',
    };

    // Step 1: Load existing entity
    const existing = await findEntityByName(params.oldName);
    if (!existing) {
      result.details = `Entity '${params.oldName}' not found`;
      return result;
    }

    // Step 2: Write the new-named entity FIRST (T-42.2-04-01 mitigation —
    // new exists before old is deleted, so there is no window of absence).
    const oldMetadata = (existing.metadata ?? {}) as Record<string, unknown>;
    const newSource: Record<string, unknown> = {
      name: params.newName,
      entityType: existing.entityType,
      ontologyClass: existing.ontologyClass,
      description: existing.description,
      observations: [],
      metadata: {
        ...oldMetadata,
        renamedFrom: params.oldName,
        renamedAt: new Date().toISOString(),
      },
    };

    try {
      await storeEntity(newSource, { team: params.team });
    } catch (err) {
      result.details = `Rename failed at store-new step: ${err instanceof Error ? err.message : String(err)}`;
      return result;
    }

    // Step 3: Migrate files if requested (best-effort, matches legacy)
    if (migrateFiles && params.insightsDir) {
      try {
        const fileResults = migrateLegacyEntityFiles(
          params.oldName,
          params.newName,
          params.insightsDir,
        );
        result.migratedFiles = fileResults.migrated;
        result.deletedFiles = fileResults.deleted;
      } catch (fileErr) {
        // File migration is best-effort — log via stderr but continue
        process.stderr.write(
          `[km-core-adapter.renameEntity] File migration warning: ${
            fileErr instanceof Error ? fileErr.message : String(fileErr)
          }\n`,
        );
      }
    }

    // Step 4: Delete the old-named entity
    try {
      await deleteEntity(params.oldName, params.team);
    } catch (err) {
      result.details = `Rename succeeded at store-new + migrate-files but delete-old failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      return result;
    }

    result.success = true;
    result.details = `Successfully renamed '${params.oldName}' to '${params.newName}'`;
    return result;
  }

  // -------------------------------------------------------------------------
  // updateEntityObservations — Phase 42.2 Plan 04
  // -------------------------------------------------------------------------

  async function updateEntityObservations(params: {
    entityName: string;
    team: string;
    removeObservations: string[];
    newObservations?: Array<string | { content: string; type?: string; metadata?: Record<string, unknown> }>;
  }): Promise<{
    success: boolean;
    updatedEntity: Entity | null;
    removedCount: number;
    addedCount: number;
    details: string;
  }> {
    const result = {
      success: false,
      updatedEntity: null as Entity | null,
      removedCount: 0,
      addedCount: 0,
      details: '',
    };

    const entity = await findEntityByName(params.entityName);
    if (!entity) {
      result.details = `Entity '${params.entityName}' not found in team '${params.team}'`;
      return result;
    }

    // Existing observations may be stored either in description (joined) or
    // in metadata.observations (array). Read both shapes for robustness.
    const existingMetadata = (entity.metadata ?? {}) as Record<string, unknown>;
    const existingObs: Array<string | { content?: string; type?: string }> =
      Array.isArray((existingMetadata as { observations?: unknown }).observations)
        ? ((existingMetadata as { observations: Array<string | { content?: string; type?: string }> }).observations)
        : [];

    const originalCount = existingObs.length;

    // Remove stale observations (substring match for flexibility, matches
    // legacy persistence-agent.ts:2932-2941).
    let remaining = existingObs;
    if (params.removeObservations.length > 0) {
      remaining = existingObs.filter((obs) => {
        const obsContent = typeof obs === 'string' ? obs : (obs.content ?? '');
        const shouldRemove = params.removeObservations.some((toRemove) =>
          obsContent.includes(toRemove) || toRemove.includes(obsContent.substring(0, 50)),
        );
        return !shouldRemove;
      });
      result.removedCount = originalCount - remaining.length;
    }

    // Append new observations
    if (params.newObservations && params.newObservations.length > 0) {
      remaining = [...remaining, ...params.newObservations];
      result.addedCount = params.newObservations.length;
    }

    // Persist via mergeAttributes
    try {
      await store.mergeAttributes(entity.id, {
        metadata: {
          ...existingMetadata,
          observations: remaining,
          last_updated: new Date().toISOString(),
        },
      } as Partial<Entity>);
    } catch (err) {
      result.details = `Failed to persist observation update: ${err instanceof Error ? err.message : String(err)}`;
      return result;
    }

    result.success = true;
    result.updatedEntity = entity;
    result.details = `Removed ${result.removedCount}, added ${result.addedCount} observations`;
    return result;
  }

  // -------------------------------------------------------------------------
  // queryIncomingRelations — Phase 42.1 INT-02
  // -------------------------------------------------------------------------

  async function queryIncomingRelations(toName: string): Promise<Relation[]> {
    const target = await findEntityByName(toName);
    if (!target) {
      // Tolerant no-op — caller treats empty result as "no anchor known".
      return [];
    }
    return store.findRelations({ to: target.id });
  }

  // -------------------------------------------------------------------------
  // Cold-path stubs — RESEARCH §3 closing recommendation
  // -------------------------------------------------------------------------

  async function queryRelations(_options?: Record<string, unknown>): Promise<never> {
    throw new Error(
      'NotImplementedError: km-core-adapter.queryRelations — no callers in src/, fill in when needed',
    );
  }
  async function queryByOntologyClass(_options?: Record<string, unknown>): Promise<never> {
    throw new Error(
      'NotImplementedError: km-core-adapter.queryByOntologyClass — no callers in src/, fill in when needed',
    );
  }
  async function findRelated(_entityName: string, _depth?: number, _filter?: unknown): Promise<never> {
    throw new Error(
      'NotImplementedError: km-core-adapter.findRelated — no callers in src/, fill in when needed',
    );
  }

  return {
    initialize,
    get initialized(): boolean {
      return true;
    },
    close,
    mergeAttributes,
    queryEntities,
    storeEntity,
    storeRelationship,
    getEntity,
    deleteEntity,
    renameEntity,
    updateEntityObservations,
    queryIncomingRelations,
    queryRelations,
    queryByOntologyClass,
    findRelated,
  };
}
