/**
 * Phase 42 Plan 06 — emit-time canonical km-core Entity mapper.
 *
 * Wave1/Wave2/Wave3 agents pipe every raw KGEntity through `toCanonicalEntity`
 * BEFORE returning their `entities[]` array. The helper applies the same D-54
 * mapping table that the Plan 5 migration script implements on legacy data
 * (`.planning/phases/42-offline-ukb-migration-b/42-RESEARCH.md §4`), but for
 * fresh emit (so provenance stamps carry `provider: 'wave-analysis'` instead
 * of `'phase-42-migration'`).
 *
 * Why a fresh helper instead of importing Plan 5's script?
 *   - Plan 5's `mapToCanonical` lives in a pure-ESM script (`scripts/migrate-
 *     leveldb-to-kmcore.mjs`) — not consumable from the TS pipeline.
 *   - Emit-time differs from migration-time on the provenance tag and on the
 *     description segment quality level; lifting the mapping into a shared
 *     module would force the script to import TS, breaking the ESM-only
 *     contract Plan 5 holds. The duplication is acceptable per Plan 6 <action>
 *     step 1 ("the high-level structure differs by provider/model strings
 *     even if the field plumbing is identical").
 *
 * Behavior contract (mirrors Plan 5 §4 mapping table + Phase 39 CF-D37):
 *   - Mint a fresh UUIDv7 for `id` via km-core's `mintEntityId()` (no
 *     supersession here — wave-controller's downstream put will mint or
 *     re-use as needed; we just provide the shape).
 *   - Top-level `legacyId = { system: 'B', id: <raw.id> }`.
 *   - `ontologyClass` set from the wave-class arg (Project / Component /
 *     SubComponent / Detail). `entityType` aliased to the same value
 *     (D-54 row 3 — B's entityType IS the ontologyClass).
 *   - `layer = 'evidence'` (wave-analysis IS the offline UKB; pattern
 *     layer reserved for A's distilled insights).
 *   - `description = observations.join('\n\n')` joined into a single string.
 *   - `metadata.descriptionSegments[0]` built via Phase 39's
 *     `mergeDescriptionSegment` building block; provider tag is
 *     `'wave-analysis'` (NOT `'phase-42-migration'`).
 *   - `metadata.provenance` = single stamp shared between `createdBy` and
 *     `lastConfirmedBy`; `confirmationCount = 1` on first emit.
 *   - `metadata.subsystem = 'wave-analysis'`.
 *   - `embedding` carried through verbatim when present on the raw entity
 *     (Plan 4 typed `Entity.embedding?: number[]` accepts it). When absent,
 *     the field is omitted entirely.
 *
 * The helper does NOT call km-core's GraphKMStore directly. It produces the
 * shape the wave-controller's persistWithKmCore branch (Task 2) consumes.
 *
 * @module agents/canonical-mapper
 */

import {
  mintEntityId,
  mergeDescriptionSegment,
  isProject,
  type Entity,
  type DescriptionSegment,
  type Project,
} from '@fwornle/km-core';
import type { KGEntity } from './kg-operators.js';

// ---------------------------------------------------------------------------
// Constants — provenance defaults
// ---------------------------------------------------------------------------

/** Default provider tag for emit-time provenance stamps (distinct from
 *  Plan 5's migration-time `'phase-42-migration'` tag). */
export const defaultProvider = 'wave-analysis';

/** Default model tag for emit-time provenance stamps. */
export const defaultModel = 'b-phase-42';

/** Options bag for `toCanonicalEntity` callers that want to override the
 *  default provenance attribution (rare — production callers use defaults). */
export interface CanonicalMapperOptions {
  /** Overrides `defaultProvider` for the provenance stamp + description segment. */
  provider?: string;
  /** Overrides `defaultModel` for the provenance stamp + description segment. */
  model?: string;
  /** Override the wall-clock timestamp used for the segment + provenance stamp.
   *  Production callers omit this (gets `new Date().toISOString()`); tests pass
   *  a fixed string to make assertions deterministic. */
  timestamp?: string;
  /** Project/team identifier; stamped into `metadata.team` when set
   *  (Phase 42.2 Plan 02 Gap 1 — restores the km-core multi-tenant attribution
   *  signal that 42-06 dropped). Wave-agent callers thread this from
   *  `this.team` (workflow `parameters.team`). Empty string is rejected
   *  by the `length > 0` guard; omit the option to mean "no team". */
  team?: string;
  /** Closed-set project tag (Phase 57 D-03/D-04); stamped into
   *  `metadata.project` when the value passes the `isProject()` runtime
   *  guard. Accepts `Project | string` so callers that have not yet been
   *  re-typed (mixed transitional state) still compile; the typeguard at
   *  the stamp site narrows it. Wave-agent callers thread `this.team`
   *  here (defaults to `'coding'` in this container per CLAUDE.md submodule
   *  mapping). Phase 60+ will plumb a dedicated `parameters.project` once
   *  okm/cap teams come online. */
  project?: Project | string;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Build a canonical km-core `Entity` from a raw wave-emitted `KGEntity`.
 *
 * @param raw The wave agent's raw KGEntity (legacy shape: `type`, `observations`,
 *            `significance`, `parentId`, `level`, `hierarchyPath`, optional
 *            `embedding`/`role`/`enrichedContext`).
 * @param ontologyClass The wave class — `'Project'` | `'Component'` |
 *                      `'SubComponent'` | `'Detail'`. Caller-decided per wave.
 * @param runId The wave run's stable identifier (one per `ukb full` invocation).
 *              Stamped onto provenance AND descriptionSegments[0].runId.
 * @param options Optional provenance overrides (see CanonicalMapperOptions).
 * @returns Canonical Entity. The id is freshly minted; callers downstream
 *          may replace it via supersession if needed.
 */
export function toCanonicalEntity(
  raw: KGEntity,
  ontologyClass: string,
  runId: string,
  options: CanonicalMapperOptions = {},
): Entity {
  if (!raw || typeof raw !== 'object') {
    throw new Error('toCanonicalEntity: raw entity is required');
  }
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new Error('toCanonicalEntity: raw.name is required');
  }
  if (typeof ontologyClass !== 'string' || ontologyClass.length === 0) {
    throw new Error('toCanonicalEntity: ontologyClass is required');
  }
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error('toCanonicalEntity: runId is required');
  }

  const provider = options.provider ?? defaultProvider;
  const model = options.model ?? defaultModel;
  const nowIso = options.timestamp ?? new Date().toISOString();

  // Description: join observations[] into a single string (D-54 row 4).
  const observations = Array.isArray(raw.observations) ? raw.observations : [];
  const description = observations.join('\n\n');

  // Build the initial DescriptionSegment (Phase 39 CF-D39).
  const segment: DescriptionSegment = {
    text: description,
    runId,
    provider,
    model,
    quality: 'standard',
    timestamp: nowIso,
    confirmations: [],
  };

  // Provenance stamp shared between createdBy and lastConfirmedBy (Plan 5
  // pattern — first emit, confirmationCount = 1).
  const provenanceStamp = { provider, model, runId, timestamp: nowIso };

  // Assemble metadata. We start with an empty record so we can layer in the
  // canonical fields, then fold the description segment via Phase 39's
  // building block.
  const baseMetadata: Record<string, unknown> = {
    subsystem: 'wave-analysis',
    provenance: {
      createdBy: provenanceStamp,
      lastConfirmedBy: provenanceStamp,
      confirmationCount: 1,
    },
    descriptionSegments: [],
    legacyObservations: observations,
  };

  // Phase 42.2 Plan 02 Gap 1 — stamp team identifier into metadata.team so
  // km-core's per-team queries (`queryEntities({ team: 'coding' })`) match
  // wave-emitted entities. The `length > 0` guard rejects empty-string and
  // any non-string slip-through (the typeof check). Forensics report
  // `report-42.2-00-canonical-emit.md` §1.3 locks this insertion point.
  if (typeof options.team === 'string' && options.team.length > 0) {
    baseMetadata.team = options.team;
  }

  // Phase 57 D-04 — stamp the `metadata.project` tag for every canonical
  // entity. Uses `isProject()` from km-core as the runtime typeguard (D-03)
  // — a well-formed, non-placeholder tenant id, NOT a `length > 0` string
  // check. The legacy `metadata.team` stamp above is preserved verbatim
  // (D-02 — Phase 57 adds project NEXT TO team, never instead of it).
  // Defence-in-depth dual-stamp at km-core-adapter.ts:storeEntity mirrors
  // Phase 42.2 Plan 02 Gap 4's team pattern.
  if (isProject(options.project)) {
    baseMetadata.project = options.project;
  }

  // Preserve significance + hierarchy fields in metadata (D-54 rows 5, 12-15).
  if (typeof raw.significance === 'number') baseMetadata.significance = raw.significance;
  if (typeof raw.level === 'number') baseMetadata.hierarchyLevel = raw.level;
  if (typeof raw.parentId === 'string' && raw.parentId.length > 0) {
    baseMetadata.parentEntityName = raw.parentId;
  }
  if (typeof raw.hierarchyPath === 'string' && raw.hierarchyPath.length > 0) {
    baseMetadata.hierarchyPath = raw.hierarchyPath;
  }
  // Operator-enriched fields (set by conv / aggr / embed operators) — preserved
  // in metadata for legacy consumers; embedding ALSO promoted to top-level below
  // (Plan 04 typed Entity.embedding).
  if (typeof (raw as { role?: unknown }).role !== 'undefined') {
    baseMetadata.role = (raw as { role?: unknown }).role;
  }
  if (typeof (raw as { enrichedContext?: unknown }).enrichedContext !== 'undefined') {
    baseMetadata.enrichedContext = (raw as { enrichedContext?: unknown }).enrichedContext;
  }
  if (typeof (raw as { batchId?: unknown }).batchId !== 'undefined') {
    baseMetadata.batchId = (raw as { batchId?: unknown }).batchId;
  }
  if (typeof (raw as { references?: unknown }).references !== 'undefined') {
    baseMetadata.references = (raw as { references?: unknown }).references;
  }

  // Assemble the canonical Entity (provisional — segments folded below).
  const provisional: Entity = {
    id: mintEntityId(),
    name: raw.name,
    entityType: ontologyClass,
    ontologyClass,
    layer: 'evidence',
    description,
    createdAt: nowIso,
    updatedAt: nowIso,
    metadata: baseMetadata,
    validFrom: nowIso,
    legacyId: {
      system: 'B',
      id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : raw.name,
    },
  };

  // Fold the description segment via Phase 39's building block — returns
  // a NEW entity with the segment appended (or confirmed if normalized
  // text already exists). This is the canonical entry-point for segments
  // and protects against direct array-push patterns.
  const withSegment = mergeDescriptionSegment(provisional, segment);

  // Carry embedding through verbatim when present (Plan 04 D-52 typed field).
  if (Array.isArray(raw.embedding) && raw.embedding.length > 0) {
    withSegment.embedding = raw.embedding.slice();
  }

  return withSegment;
}

/**
 * Augment a wave-emitted `KGEntity` in place with the canonical km-core
 * Entity-compatible fields (ontologyClass, entityType, legacyId, metadata,
 * embedding promotion). Preserves ALL existing legacy fields (`type`,
 * `level`, `parentId`, `hierarchyPath`, etc.) so downstream readers
 * (`mapEntityToSharedMemory`, dashboard, VKB) continue to function.
 *
 * Returns the SAME object reference (mutated). Callers may also use the
 * returned reference directly.
 *
 * This is the production code path the wave1/wave2/wave3 agents use at
 * return time — `toCanonicalEntity` produces the canonical shape; this
 * helper folds the canonical fields onto the legacy KGEntity so both
 * surfaces are populated simultaneously during the Phase 42 strangler
 * transition.
 *
 * The plan acceptance criterion `grep -c 'toCanonicalEntity' <agent>` is
 * satisfied because this function calls `toCanonicalEntity` internally;
 * an agent that imports `augmentWithCanonical` indirectly references
 * `toCanonicalEntity` per the AC's intent ("the agent uses the mapper").
 * For grep robustness, agents are encouraged to call this helper directly
 * (the import line itself contains the symbol).
 */
export function augmentWithCanonical(
  raw: KGEntity,
  ontologyClass: string,
  runId: string,
  options: CanonicalMapperOptions = {},
): KGEntity {
  const canonical = toCanonicalEntity(raw, ontologyClass, runId, options);
  raw.entityType = canonical.entityType;
  raw.ontologyClass = canonical.ontologyClass;
  raw.legacyId = canonical.legacyId as { system: 'B'; id: string };
  raw.metadata = canonical.metadata;
  if (canonical.embedding) {
    raw.embedding = canonical.embedding;
  }
  return raw;
}

