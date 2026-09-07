/**
 * Wave Analysis Type Contracts
 *
 * Shared interfaces used by WaveController and all three wave agents.
 * Defines the data contracts for hierarchical wave execution:
 *   Wave 1: L0/L1 (Project + Components)
 *   Wave 2: L2 (SubComponents)
 *   Wave 3: L3 (Detail entities)
 *
 * @module types/wave-types
 */

import type { KGEntity, KGRelation } from '../agents/kg-operators.js';
import type { ComponentManifest } from './component-manifest.js';

// ============================================================================
// Analysis Artifact & Trace Data Contracts
// ============================================================================

/**
 * Artifacts produced by deep code analysis of an entity.
 * Captures patterns, architecture notes, and grounding references.
 */
export interface AnalysisArtifacts {
  /** Architectural patterns discovered in the entity's code */
  patterns: string[];
  /** Architecture observations from code analysis */
  architectureNotes: string[];
  /** Specific file/line references grounding the analysis */
  codeReferences: string[];
  /** Raw CGR evidence strings preserved through the pipeline */
  cgrEvidence?: string[];
}

/**
 * Trace data from a single agent's contribution to entity analysis.
 * Used for observability and debugging of the multi-agent pipeline.
 */
export interface EntityTraceData {
  /** Number of LLM calls made by this agent */
  llmCallCount: number;
  /** Total wall clock duration in milliseconds */
  totalDurationMs: number;
  /** LLM model used (e.g. 'gpt-4o', 'llama-3.3-70b') */
  model: string;
  /** LLM provider used (e.g. 'openai', 'groq') */
  provider: string;
  /** Agent type identifier (e.g. 'SemanticAnalysisAgent', 'OntologyClassificationAgent') */
  agentType: string;
  /** Number of CGR queries made by this agent */
  cgrQueryCount?: number;
  /** Total CGR query duration in milliseconds */
  cgrDurationMs?: number;
  /** Number of code entities returned by CGR queries */
  cgrEntitiesReturned?: number;
}

/**
 * KGEntity enriched with analysis artifacts and trace data.
 * Produced by the agent pipeline and consumed by insight generation.
 */
export interface EnrichedEntity extends KGEntity {
  /** Analysis artifacts attached by SemanticAnalysisAgent */
  _analysisArtifacts?: AnalysisArtifacts;
  /** Trace data from each agent that contributed (array because multiple agents contribute) */
  _traceData?: EntityTraceData[];
  /** Fallback flag when SemanticAnalysisAgent fails -- signals shallow analysis */
  _shallowAnalysis?: boolean;
  /** Flag set when no CGR evidence was found for this entity */
  _noCgrEvidence?: boolean;
}

/**
 * Input contract for SemanticAnalysisAgent.analyzeEntityCode().
 * Provides the per-entity context needed for deep code analysis.
 */
export interface AnalyzeEntityCodeInput {
  /** PascalCase entity name */
  entityName: string;
  /** Entity type (e.g. 'Component', 'SubComponent', 'Detail') */
  entityType: string;
  /** Pre-scoped file paths from wave agent */
  codeFiles: string[];
  /** Parent entity observations for grounding */
  parentContext: string[];
  /** Analysis depth -- always 'deep' for wave integration */
  analysisDepth: 'deep';
  /** CGR context data injected as a separate parameter (not merged into parentContext) */
  cgrContext?: string;
}

/**
 * Output contract from SemanticAnalysisAgent.analyzeEntityCode().
 * Contains deep observations, analysis artifacts, and trace data.
 */
export interface AnalyzeEntityCodeResult {
  /** Deep, multi-paragraph observations about architecture, patterns, trade-offs */
  observations: string[];
  /** Structured analysis artifacts */
  artifacts: AnalysisArtifacts;
  /** Trace data from the LLM call */
  traceData: EntityTraceData;
}

// ============================================================================
// Wave Controller Configuration
// ============================================================================

/**
 * Constructor configuration for WaveController.
 */
export interface WaveControllerConfig {
  /** Absolute path to the repository being analyzed */
  repositoryPath: string;
  /** Team name for knowledge graph storage (e.g. "coding") */
  team: string;
  /** Absolute path to workflow-progress.json for status updates */
  progressFile: string;
  /** Maximum number of agents to run concurrently within a single wave (default: 4) */
  maxAgentsPerWave?: number;
  /** If true, abort remaining waves when any agent fails (default: true) */
  failFast?: boolean;
  /**
   * An already-open km-core GraphKMStore owned by the CALLER.
   *
   * km-core's LevelDB is single-owner-rw: obs-api
   * (scripts/observations-api-server.mjs) holds the lock on
   * .data/knowledge-graph/leveldb for the life of the process, and every other
   * consumer is expected to reach the store through it. A WaveController
   * running in its own process therefore cannot open the DB at all — it fails
   * at bootstrap with "Database failed to open", which is what silently killed
   * every wave-analysis run after the Plan 44-12 cutover (2026-06-04).
   *
   * Pass the owner's store to run in-process instead. When set, WaveController
   * uses it as-is and never opens or closes it — the owner's lifecycle wins.
   * When unset the old behaviour stands: construct and open a private store,
   * which still works wherever nothing else holds the lock.
   */
  kmStore?: KmStoreHandle;
}

/**
 * An open km-core GraphKMStore, structurally typed.
 *
 * Deliberately not `import('@fwornle/km-core').GraphKMStore`: this type is
 * consumed by a plain-JS host process (obs-api) that already holds a store
 * instance, and a nominal import here would drag km-core's types into every
 * consumer of wave-types for no benefit. WaveController only ever hands the
 * value to createKmCoreAdapter().
 */
export type KmStoreHandle = object;

// ============================================================================
// Child Manifest Entry
// ============================================================================

/**
 * Output from each wave agent describing what children should exist for the next wave.
 * Wave agents produce these to signal the WaveController what to spawn next.
 */
export interface ChildManifestEntry {
  /** PascalCase entity name (e.g. "ManualLearning") */
  name: string;
  /** Hierarchy level: 2 for L2 SubComponent, 3 for L3 Detail */
  level: number;
  /** Entity name of the parent node (e.g. "KnowledgeManagement") */
  parentId: string;
  /** LLM-generated description of what this child covers */
  description: string;
  /** True if this child was discovered from code analysis (not pre-defined in manifest) */
  discovered: boolean;
  /** Source files most relevant to this child component */
  suggestedFiles?: string[];
  /** Keywords for scoping code-graph-rag queries for this child */
  keywords?: string[];
}

// ============================================================================
// Wave Agent Output
// ============================================================================

/**
 * Standard output from any wave agent (Wave1ProjectAgent, Wave2ComponentAgent, Wave3DetailAgent).
 * All three agents produce this shape so WaveController can handle them uniformly.
 */
export interface WaveAgentOutput {
  /** Entities produced by this agent */
  entities: KGEntity[];
  /** Relationship edges produced by this agent (parent-child + discovered links) */
  relationships: KGRelation[];
  /** Children to spawn in the next wave */
  childManifest: ChildManifestEntry[];
  /** True if this agent was spawned from a discovery (not pre-defined in manifest) */
  discovered: boolean;
  /** Wall clock duration for this agent in milliseconds */
  durationMs: number;
  /** Entity name of the parent this agent expanded (e.g. "KnowledgeManagement") */
  parentId: string;
  /** Human-readable agent identifier for logging (e.g. "Wave2:SemanticAnalysis") */
  agentName: string;
}

// ============================================================================
// Wave Result
// ============================================================================

/**
 * Aggregated result from one complete wave (all agents for that wave combined).
 */
export interface WaveResult {
  /** Wave number: 1, 2, or 3 */
  wave: number;
  /** Individual outputs from each agent that ran in this wave */
  agentOutputs: WaveAgentOutput[];
  /** Total entity count across all agent outputs in this wave */
  totalEntities: number;
  /** Count of entities that were defined in the component manifest */
  manifestEntities: number;
  /** Count of entities discovered dynamically from code analysis */
  discoveredEntities: number;
  /** Total wall clock duration for this wave in milliseconds */
  durationMs: number;
  /** True if the wave completed without failures */
  success: boolean;
  /** Error message if success is false */
  error?: string;
}

// ============================================================================
// Wave Execution Result
// ============================================================================

/**
 * Final result from a complete three-wave execution.
 * Returned by WaveController.execute().
 */
export interface WaveExecutionResult {
  /** True if all three waves completed successfully */
  success: boolean;
  /** Individual wave results for Wave 1, 2, and 3 */
  waves: WaveResult[];
  /** Total entity count across all three waves */
  totalEntities: number;
  /** Total wall clock duration for the entire execution in milliseconds */
  totalDurationMs: number;
  /** Entity counts broken down by hierarchy level (e.g. {0: 1, 1: 8, 2: 12, 3: 45}) */
  entitiesByLevel: Record<number, number>;
  /** Total count of manifest-defined entities across all waves */
  manifestEntities: number;
  /** Total count of discovered entities across all waves */
  discoveredEntities: number;
  /** Top-level error message if success is false */
  error?: string;
}

// ============================================================================
// Wave Agent Inputs
// ============================================================================

/**
 * Input to Wave1ProjectAgent.
 * Wave 1 creates L0 (Project) and L1 (Component) nodes using the manifest as structure
 * and existing KG entities as additional context.
 */
export interface Wave1Input {
  /** The component manifest — authoritative L0/L1 structure definition */
  manifest: ComponentManifest;
  /** Existing entities in the knowledge graph (used as enrichment context) */
  existingEntities: KGEntity[];
  /** Absolute path to the repository being analyzed */
  repositoryPath: string;
  /** Optional documentation context from DocumentationLinkerAgent (injected into LLM prompts) */
  docContext?: string;
  /** Optional callback invoked at each semantic phase transition (for single-step pause support) */
  onPhase?: (phase: string) => Promise<void>;
}

/**
 * Input to Wave2ComponentAgent.
 * Wave 2 receives one L1 entity and expands it into L2 SubComponent nodes.
 */
export interface Wave2Input {
  /** The L1 entity this agent is expanding (parent context) */
  l1Entity: KGEntity;
  /** Source files scoped to this L1 component via code-graph-rag query */
  componentFiles: string[];
  /** Keywords from the manifest entry for this component (used for CGR scoping) */
  componentKeywords: string[];
  /** Pre-defined L2 children from the component manifest (may be extended by discovery) */
  manifestChildren: ChildManifestEntry[];
  /** Optional documentation context from DocumentationLinkerAgent (injected into LLM prompts) */
  docContext?: string;
  /** Optional callback invoked at each semantic phase transition (for single-step pause support) */
  onPhase?: (phase: string) => Promise<void>;
}

/**
 * Input to Wave3DetailAgent.
 * Wave 3 receives one L2 entity and discovers L3 Detail nodes from code analysis.
 */
export interface Wave3Input {
  /** The L2 entity this agent is expanding (direct parent) */
  l2Entity: KGEntity;
  /** The grandparent L1 entity (for hierarchy path construction) */
  l1Entity: KGEntity;
  /** Source files relevant to this L2 sub-component via code-graph-rag query */
  scopedFiles: string[];
  /** L3 children suggested by Wave 2 agent -- used as discovery seeds, not authoritative */
  suggestedChildren?: ChildManifestEntry[];
  /** Optional documentation context from DocumentationLinkerAgent (injected into LLM prompts) */
  docContext?: string;
  /** Optional callback invoked at each semantic phase transition (for single-step pause support) */
  onPhase?: (phase: string) => Promise<void>;
}
