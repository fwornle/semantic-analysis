/**
 * Deterministic L2 subsystem classifier — Phase 60 Plan 09 (SC#5 / LOWERONTO-03).
 *
 * Pure, synchronous name+description -> L2 class mapper over the CLOSED 10-class
 * coding subsystem vocabulary (coding.lower.json). No LLM, no async, no fs reads,
 * so BOTH the writer agent (ontology-classification-agent.ts) and the one-shot
 * migration (scripts/backfill-l2-subsystem-class.mjs) import the SAME mapping —
 * one implementation, zero copy-paste drift.
 *
 * Why deterministic (not LLM): the L2 vocabulary is a closed set of 10 subsystem
 * identities and entity names already encode subsystem membership (LiveLoggingSystem,
 * KnowledgeManagement, DockerizedServices are exact; SemanticAnalysis->BatchSemanticAnalysis,
 * ConstraintSystem->ConstraintMonitor, LLMAbstraction->RapidLlmProxy). Entities carry no
 * usable path/tags signal (filePath/path/tags/parent all null) — the only signal is
 * name+description, which is exactly what a lookup uses. A migration over ~1140 entities
 * must be cheap, idempotent and re-runnable; the deterministic mapper yields the SAME
 * result every run. See 60-09-PLAN.md approach_decision_for_research.
 *
 * Invariant (no forced L2, Phase 57 D-10): returns null whenever there is no confident
 * keyword match — generic entities (CachingMechanism, TranscriptAdapter) keep their L1
 * class. Parent-consistency: only an L2 whose `parent` equals the entity's L1 class is
 * ever returned (a Detail can only refine to OnlineObservation/OnlineDigest/OnlineInsight;
 * a SubComponent only to EtmDaemon; a Component only to the 6 Component-parented L2s).
 * Hierarchy roots are skipped UPSTREAM (the writer's hard-root-guard / the migration's
 * isHierarchyRoot filter) — they must never be refined.
 */

export type L2Parent = 'Component' | 'SubComponent' | 'Detail';

export interface L2Entry {
  /** The L1 carrier class this L2 extends (parent-consistency edge). */
  parent: L2Parent;
  /**
   * Case-insensitive match terms. A term containing whitespace/hyphen/dot/slash
   * is matched as a SUBSTRING; a bare single token (e.g. "etm", "lsl", "ukb") is
   * matched on WORD BOUNDARIES to avoid mid-word collisions.
   */
  keywords: string[];
}

/**
 * The closed 10-class vocabulary keyed by L2 class name. Iteration order IS the
 * tie-break order: first class (within the entity's L1 parent group) whose keyword
 * matches wins. Keep keywords tight — broad generic words (e.g. "container",
 * "coordinator") risk mis-routing the handful of generic Component entities.
 */
export const L2_KEYWORD_MAP: Record<string, L2Entry> = {
  // --- Component-parented (6) ---
  LiveLoggingSystem: {
    parent: 'Component',
    keywords: ['livelogging', 'live session log', 'lsl', '.specstory', 'session logging'],
  },
  ConstraintMonitor: {
    parent: 'Component',
    keywords: ['constraintsystem', 'constraint monitor', 'constraint-monitor', 'no-console-log'],
  },
  KnowledgeManagement: {
    parent: 'Component',
    keywords: ['knowledgemanagement', 'km-core', 'knowledge graph', 'knowledge management'],
  },
  BatchSemanticAnalysis: {
    parent: 'Component',
    keywords: ['semanticanalysis', 'batch semantic', 'wave-analysis', 'batch-analysis'],
  },
  RapidLlmProxy: {
    parent: 'Component',
    keywords: ['rapidllmproxy', 'llmabstraction', 'llm proxy', 'llm-proxy', 'llm routing'],
  },
  DockerizedServices: {
    parent: 'Component',
    keywords: ['dockerizedservices', 'docker-compose', 'coding-services', 'dockerized'],
  },
  // --- Component-parented, Phase 61 corpus extension (12) ---
  // Added from a measurement of the live coding corpus: 385 of 678 insights
  // matched NONE of the original 10 classes, because that vocabulary predates
  // the benchmark harness, experiment runner, GSD workflow, dashboard,
  // status line, graphify, token accounting and CI work. Keep keywords tight
  // and specific — a broad term here silently re-routes a whole subsystem.
  BenchmarkHarness: {
    parent: 'Component',
    keywords: ['kgbench', 'benchmark', 'graphify-vs-grep', 'coding-v1'],
  },
  AgentIntegration: {
    parent: 'Component',
    keywords: ['copilot', 'opencode', 'claude code', 'agent launcher', 'headless agent', 'pi agent', 'model catalogue'],
  },
  ExperimentFramework: {
    parent: 'Component',
    keywords: ['experiment runner', 'a/b experiment', 'kb injection', 'avenue', 'experiment harness'],
  },
  GsdWorkflow: {
    parent: 'Component',
    keywords: ['gsd', '.planning', 'plan-phase', 'execute-phase', 'milestone state'],
  },
  HealthDashboard: {
    parent: 'Component',
    keywords: ['dashboard', 'system-health-dashboard', 'health api', 'coverage tab'],
  },
  StatusLine: {
    parent: 'Component',
    keywords: ['statusline', 'status line', 'tmux'],
  },
  CodeGraph: {
    parent: 'Component',
    keywords: ['graphify', 'codegraph', 'code graph', 'code-graph'],
  },
  TokenAccounting: {
    parent: 'Component',
    keywords: ['token usage', 'token accounting', 'token_usage', 'cost model', 'cache_read', 'billing'],
  },
  OntologyAndViewer: {
    parent: 'Component',
    keywords: ['ontology', 'unified viewer', 'vkb', 'entity level'],
  },
  ContinuousIntegration: {
    parent: 'Component',
    keywords: ['github action', 'ci workflow', 'ci pipeline', 'ci run', 'cross-platform ci'],
  },
  DocumentationSystem: {
    parent: 'Component',
    keywords: ['mkdocs', 'plantuml', 'documentation', 'diagram style', 'mermaid'],
  },
  InstallAndBootstrap: {
    parent: 'Component',
    keywords: ['install.sh', 'installer', 'bootstrap', 'first-run', 'feature resolver'],
  },
  // --- Detail-parented (3) ---
  OnlineObservation: {
    parent: 'Detail',
    keywords: ['observationwriter', 'observation pipeline', 'online observation'],
  },
  OnlineDigest: {
    parent: 'Detail',
    keywords: ['observationconsolidator', 'daily digest', 'online digest', 'digest roll-up'],
  },
  OnlineInsight: {
    parent: 'Detail',
    keywords: ['insightgenerat', 'online insight', 'weekly insight'],
  },
  // --- SubComponent-parented (1) ---
  EtmDaemon: {
    parent: 'SubComponent',
    keywords: ['enhanced transcript monitor', 'transcript monitor', 'com.coding.etm', 'etm'],
  },
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Single keyword match against an already-lowercased haystack.
 *
 * Default is SUBSTRING (so compound terms like "livelogging" still match inside
 * "LiveLoggingSystem"). Only short bare tokens (<= 4 chars, no separator — e.g.
 * "etm", "lsl", "ukb") use WORD-BOUNDARY matching to avoid mid-word collisions.
 */
function keywordMatches(haystackLower: string, keyword: string): boolean {
  const k = keyword.toLowerCase();
  const isShortBareToken = k.length <= 4 && !/[\s.\-/]/.test(k);
  if (isShortBareToken) {
    return new RegExp(`\\b${escapeRegExp(k)}\\b`).test(haystackLower);
  }
  return haystackLower.includes(k);
}

/**
 * Map an entity's (name, description, l1Parent) to a closed-vocabulary L2 class,
 * or null when there is no confident, parent-consistent match.
 *
 * @param name        entity name (primary signal, scanned first)
 * @param description entity description (secondary signal)
 * @param l1Parent    the entity's current L1 class — only L2 classes whose parent
 *                    equals this value are eligible (parent-consistency invariant)
 */
export function classifyL2(
  name: string | null | undefined,
  description: string | null | undefined,
  l1Parent: string | null | undefined,
): string | null {
  if (!l1Parent) return null;
  const nameLower = (name ?? '').toLowerCase();
  const descLower = (description ?? '').toLowerCase();

  const eligible = Object.entries(L2_KEYWORD_MAP).filter(([, e]) => e.parent === l1Parent);

  // NAME is the authoritative signal: a full pass over the name (table order)
  // wins before the description is ever consulted. Otherwise a subsystem whose
  // DESCRIPTION references a sibling subsystem (e.g. SemanticAnalysis's desc
  // mentioning session-logging) would mis-route by table position. Only when no
  // class matches the name do we fall back to a description pass.
  for (const [className, entry] of eligible) {
    if (entry.keywords.some((kw) => keywordMatches(nameLower, kw))) return className;
  }
  for (const [className, entry] of eligible) {
    if (entry.keywords.some((kw) => keywordMatches(descLower, kw))) return className;
  }
  return null;
}
