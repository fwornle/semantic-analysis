/**
 * Session facts — the recorder's output, made readable by the surveyor.
 *
 * ── Why this module exists ─────────────────────────────────────────────────
 * UKB describes the code as written. The online recorder (ETM → obs-api)
 * describes the work as done: it distils sessions into Observations, rolls
 * those into Digests, and rolls those into Insights. Both populations live in
 * the SAME km-core store and, until this module, no node held both. A
 * component description that cannot mention what went wrong while building the
 * component is not knowledge — it is a restated file listing.
 *
 * The fix is deliberately NOT "re-read .specstory from the waves". That work
 * is already done, redacted and structured; re-reading raw transcripts inside
 * a wave would duplicate the recorder badly and re-import the PII problem the
 * redactor exists to solve. Instead the waves read the recorder's OUTPUT.
 *
 * ── What makes this possible now ───────────────────────────────────────────
 * Stage 2 gave every Insight a single owner: `metadata.parentId` naming the
 * hierarchy node it is mainly about, plus `metadata.parentSource` recording
 * whether the classifier or the rarity prior decided. Before that, an Insight
 * mentioned a dozen entities equally and there was no non-arbitrary way to say
 * which component it belonged to. 784 of 980 Insights carry an owner today.
 *
 * ── Grain: Insights, not Observations ──────────────────────────────────────
 * Only Insights are indexed. Observations and Digests are the raw material
 * they are distilled FROM — the same material, one and two rounds less
 * summarised, and 538 rows of it. Feeding all three to a wave prompt would
 * spend the context budget restating the same facts at three resolutions.
 * `derivedFrom` / `has_insight` edges remain the route back to the evidence
 * when a caller wants it.
 *
 * @module knowledge/session-facts
 */

import type { Entity, Relation } from '@fwornle/km-core';

/**
 * One session-derived fact, scoped to the hierarchy node it is about.
 *
 * `anchorId` is where the recorder placed it; `placement` says who decided,
 * so a prompt can weight a classifier decision above a rarity fallback and a
 * reader can audit a surprising attribution rather than trusting it.
 */
export interface SessionFact {
  /** km-core id of the source Insight — the provenance handle. */
  sourceId: string;
  /** Insight title. */
  title: string;
  /** One-line claim, trimmed from the Insight's summary or description. */
  summary: string;
  /** Hierarchy node this fact was placed under (`metadata.parentId`). */
  anchorId: string;
  /** Name of that node, for prompts and logs. */
  anchorName: string;
  /** How the placement was decided: 'classifier' | 'rarity' | ... (stage 2). */
  placement: string;
  /** Recorder confidence in [0,1] when present. */
  confidence?: number;
  /** ISO timestamp of the last update, newest-first ordering key. */
  updatedAt?: string;
}

export interface SessionFactIndexStats {
  /** Insights seen in the store. */
  insightsSeen: number;
  /** Insights carrying a `metadata.parentId` — the indexable ones. */
  insightsWithOwner: number;
  /** Facts whose anchor resolves to a node that actually exists. */
  factsIndexed: number;
  /** Anchors named by an Insight but absent from the store (dangling). */
  danglingAnchors: number;
  /** Distinct hierarchy nodes holding at least one fact. */
  anchoredNodes: number;
}

export interface SessionFactIndex {
  /** Facts anchored directly ON this node. */
  directFor(entityId: string): SessionFact[];
  /** Facts anchored on this node OR any descendant of it. */
  subtreeFor(entityId: string): SessionFact[];
  /** Same as `subtreeFor`, addressed by entity name (waves speak names). */
  subtreeForName(name: string): SessionFact[];
  /** Same as `directFor`, addressed by entity name. */
  directForName(name: string): SessionFact[];
  readonly stats: SessionFactIndexStats;
}

/** Minimal read surface this module needs — keeps it testable without a store. */
export interface SessionFactSource {
  queryEntities(options?: { ontologyClass?: string }): Promise<Entity[]>;
  queryRelations(filter?: Partial<Relation>): Promise<Relation[]>;
}

/** Guard against one pathological node swamping a prompt. */
const MAX_FACTS_PER_NODE = 200;
/** Ancestry walks are bounded — a cycle in `contains` must not hang a run. */
const MAX_ANCESTRY_DEPTH = 12;

function classOf(e: Entity): string {
  return e.ontologyClass || e.entityType || '';
}

function firstSentence(text: string, max = 320): string {
  const flat = String(text || '')
    // Insight descriptions are markdown documents; the heading scaffolding is
    // noise in a prompt that is already asking for prose.
    .replace(/^#+\s.*$/gm, ' ')
    .replace(/[*_`>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return '';
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return (stop > max * 0.5 ? cut.slice(0, stop + 1) : cut).trim() + '…';
}

/**
 * Build the index from an already-open km-core read surface.
 *
 * Two bulk reads, not one query per node: the store holds ~2,500 entities and
 * ~17,000 edges, and a per-entity `queryIncomingRelations` sweep would be
 * ~2,500 full edge scans. Both reads are O(graph) once.
 */
export async function buildSessionFactIndex(
  source: SessionFactSource,
): Promise<SessionFactIndex> {
  const entities = await readEntities(source);
  const byId = new Map<string, Entity>();
  const idByName = new Map<string, string>();
  for (const e of entities) {
    byId.set(String(e.id), e);
    // Oldest wins, matching the adapter's own name resolution — a later
    // namesake must not silently capture an older node's facts.
    if (!idByName.has(e.name)) idByName.set(e.name, String(e.id));
  }

  // `contains` is the structural parent edge the waves write. It is the
  // fallback for nodes whose `metadata.parentId` was never stamped — 104 of
  // 468 SubComponents are in exactly that state, and dropping them would lose
  // every fact hanging below them.
  const containsParent = new Map<string, string>();
  for (const r of await readContainsEdges(source)) {
    const to = String(r.to);
    if (!containsParent.has(to)) containsParent.set(to, String(r.from));
  }

  const parentOf = (id: string): string | undefined => {
    const e = byId.get(id);
    const metaParent = (e?.metadata as { parentId?: unknown } | undefined)?.parentId;
    if (typeof metaParent === 'string' && metaParent) return metaParent;
    return containsParent.get(id);
  };

  // ---- collect facts -------------------------------------------------------
  const direct = new Map<string, SessionFact[]>();
  const stats: SessionFactIndexStats = {
    insightsSeen: 0,
    insightsWithOwner: 0,
    factsIndexed: 0,
    danglingAnchors: 0,
    anchoredNodes: 0,
  };

  for (const e of entities) {
    if (classOf(e) !== 'Insight') continue;
    stats.insightsSeen += 1;
    const meta = (e.metadata ?? {}) as Record<string, unknown>;
    const anchorId = typeof meta.parentId === 'string' ? meta.parentId : '';
    if (!anchorId) continue;
    stats.insightsWithOwner += 1;

    const anchor = byId.get(anchorId);
    if (!anchor) {
      // The Insight names an owner the store no longer holds. Counted rather
      // than silently skipped: a rising number here means placement is writing
      // ids that a later dedupe/merge pass invalidates.
      stats.danglingAnchors += 1;
      continue;
    }

    const summary =
      firstSentence(typeof meta.summary === 'string' ? meta.summary : '') ||
      firstSentence(e.description || '');
    if (!summary) continue;

    const fact: SessionFact = {
      sourceId: String(e.id),
      title: e.name,
      summary,
      anchorId,
      anchorName: anchor.name,
      placement: typeof meta.parentSource === 'string' ? meta.parentSource : 'unknown',
      confidence: typeof meta.confidence === 'number' ? meta.confidence : undefined,
      updatedAt:
        (typeof meta.lastUpdated === 'string' && meta.lastUpdated) || e.updatedAt || undefined,
    };
    const bucket = direct.get(anchorId);
    if (bucket) bucket.push(fact);
    else direct.set(anchorId, [fact]);
    stats.factsIndexed += 1;
  }
  stats.anchoredNodes = direct.size;

  // Newest first, so a truncated prompt keeps the current state of the world
  // rather than an arbitrary slice of its history.
  for (const bucket of direct.values()) {
    bucket.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  }

  // ---- roll facts up the tree ---------------------------------------------
  // Each anchored node's facts are added to every ancestor, so asking a
  // Component returns everything recorded about its sub-components too. This
  // is what lets wave 2 describe a component using work done three levels down.
  const subtree = new Map<string, SessionFact[]>();
  for (const [anchorId, facts] of direct) {
    let cur: string | undefined = anchorId;
    const seen = new Set<string>();
    for (let depth = 0; cur && !seen.has(cur) && depth <= MAX_ANCESTRY_DEPTH; depth += 1) {
      seen.add(cur);
      const bucket = subtree.get(cur);
      if (bucket) bucket.push(...facts);
      else subtree.set(cur, [...facts]);
      cur = parentOf(cur);
    }
  }
  for (const [id, bucket] of subtree) {
    bucket.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    if (bucket.length > MAX_FACTS_PER_NODE) subtree.set(id, bucket.slice(0, MAX_FACTS_PER_NODE));
  }

  const resolve = (name: string): string | undefined => idByName.get(name);

  return {
    directFor: (id) => direct.get(id) ?? [],
    subtreeFor: (id) => subtree.get(id) ?? [],
    directForName: (name) => {
      const id = resolve(name);
      return id ? direct.get(id) ?? [] : [];
    },
    subtreeForName: (name) => {
      const id = resolve(name);
      return id ? subtree.get(id) ?? [] : [];
    },
    stats,
  };
}

/**
 * Render facts as a prompt section.
 *
 * The `[SESSION]` marker matches the `[CGR]` / `[LLM]` / `[LLM+CGR]` tags
 * `SemanticAnalysisAgent.autoTagObservations` already writes, so provenance
 * reads the same way whether a claim came from the code graph, the model, or
 * the work record. Returns '' when there is nothing to say — an empty section
 * header invites the model to invent content to fill it.
 */
export function formatSessionFacts(facts: readonly SessionFact[], limit = 12): string {
  if (!facts.length) return '';
  const shown = facts.slice(0, limit);
  const lines = shown.map((f) => {
    const where = f.anchorName ? ` (about ${f.anchorName})` : '';
    return `- ${f.title}${where}: ${f.summary}`;
  });
  const more =
    facts.length > shown.length
      ? `\n(+${facts.length - shown.length} further session records not shown)`
      : '';

  // The floor scales with what was actually supplied: demanding two
  // session-grounded observations from a component with one record on file
  // is an instruction that can only be met by inventing the second.
  const floor = shown.length >= 3 ? 2 : 1;

  return `
## What the work record says
These are facts the online recorder distilled from actual working sessions —
what was built, what broke, and what was decided. They are evidence about this
area of the system, NOT source code.
${lines.join('\n')}${more}

### How to use the work record
The rule that every observation must cite a code artifact applies to
observations about the CODE. These records are a second, independent kind of
evidence, and an observation grounded in one is held to a different standard:
it MUST name the record it comes from, and it MUST be prefixed [SESSION]
(or [SESSION+CGR] when the code graph confirms it). That naming IS its
grounding, exactly as a file path is the grounding of a code observation.

- AT LEAST ${floor} of your observations must be grounded in these records.
  They describe decisions, failures and constraints that CANNOT be recovered by
  reading the source — a component described without them is a file listing.
- NO MORE THAN HALF of your observations may be session-grounded. The code
  remains the primary subject; the work record explains it, it does not replace
  it. If the source files are thin, return fewer observations rather than
  filling the gap from the records.
- State what the record establishes, not your reaction to it. Write "tmux 3.6a
  has no MouseMove event, so the status line substitutes click feedback for
  hover"; do NOT write "This suggests that the status line may have hover
  limitations."
`;
}

/**
 * Keep the evidence a re-analysis pass cannot regenerate.
 *
 * Waves 1-3 all end by REPLACING an entity's observations with fresh output
 * from `SemanticAnalysisAgent`, which reads source files and nothing else. Two
 * kinds of observation cannot survive that on their own:
 *   `[CGR]`     — emitted by the code-graph query, not by the model.
 *   `[SESSION]` — grounded in the work record, which the SAA has no access to
 *                 beyond the block handed to it.
 *
 * All three waves carried their own copy of this filter and all three listed
 * only `[CGR]`, which is exactly how session grounding got deleted at the last
 * step of every wave. One implementation, one place to add the next tag.
 */
export function preserveUnreproducibleEvidence(observations: readonly string[]): string[] {
  return observations.filter(
    (o) => typeof o === 'string' && (o.startsWith('[CGR]') || o.startsWith('[SESSION]')),
  );
}

// --- tolerant reads --------------------------------------------------------
// A wave run must not die because the store could not answer. Session facts
// are an enrichment: without them the waves produce exactly what they produced
// before this module existed.

async function readEntities(source: SessionFactSource): Promise<Entity[]> {
  try {
    return (await source.queryEntities()) ?? [];
  } catch {
    return [];
  }
}

async function readContainsEdges(source: SessionFactSource): Promise<Relation[]> {
  try {
    return (await source.queryRelations({ type: 'contains' })) ?? [];
  } catch {
    return [];
  }
}
