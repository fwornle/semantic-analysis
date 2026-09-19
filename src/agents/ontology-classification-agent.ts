/**
 * OntologyClassificationAgent
 *
 * Classifies observations and entities against the ontology system.
 * Adds ontology metadata to entities before persistence.
 * Tracks unclassified patterns for auto-extension suggestions.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { log } from '../logging.js';
import {
  OntologyConfigManager,
  ExtendedOntologyConfig,
} from '../ontology/OntologyConfigManager.js';
// Phase 42-03: legacy ontology-load class deleted; this agent now constructs
// km-core's OntologyRegistry directly and wraps it in LegacyOntologyAdapter
// so the still-B-specific Validator + Classifier keep working unchanged.
import { LegacyOntologyAdapter } from '../ontology/LegacyOntologyAdapter.js';
import { OntologyValidator } from '../ontology/OntologyValidator.js';
import { OntologyClassifier } from '../ontology/OntologyClassifier.js';
import { createHeuristicClassifier } from '../ontology/heuristics/index.js';
import type { OntologyClassification } from '../ontology/types.js';
import { SemanticAnalyzer } from './semantic-analyzer.js';
import { PROCESS_TAGS } from './process-tags.js';
// km-core OntologyRegistry — single-level directory walk, atomic reload.
// The root-barrel import is used (not the '/ontology' sub-path) because the
// submodule's tsconfig uses `moduleResolution: node` which does not honor
// package.json `exports` sub-paths (same precedent as Phase 42-01 SUMMARY
// deviation #2). Functionally equivalent — OntologyRegistry is re-exported
// from the root barrel.
import { OntologyRegistry } from '@fwornle/km-core';
import type { ResolvedClass } from '@fwornle/km-core';
// Phase 60 D-14 — closed-set hierarchy roots (CK + 4 project anchors)
// whose ontologyClass is hard-locked. The writer-side guard below
// short-circuits LLM re-classification for these names so an adversarial
// LLM verdict cannot drift CK back to 'Detail' (D-12 root cause). Pattern
// source: quality-assurance-agent.ts:1921 exemptNodes Set, narrowed to 5.
import { HIERARCHY_ROOTS, HIERARCHY_ROOT_CLASS, isHierarchyRoot } from '@fwornle/km-core';
// Phase 60 Plan 09 — deterministic L2 refinement (SC#5 / LOWERONTO-03). Shared
// closed-vocabulary keyword mapper, also imported by the backfill migration.
import { classifyL2 } from './l2-subsystem-classifier.js';
// Surface witness — touching the named exports at runtime forces the import
// to be retained by tree-shakers. HIERARCHY_ROOTS itself is referenced by
// the test file so it cannot be dead-code-eliminated; this constant keeps
// the runtime guard happy under strict bundlers.
void HIERARCHY_ROOTS;

// Phase 57 Plan 04 D-10 — L2 refinement helpers.
//
// The refinement step turns a generic L1 classification (Component / SubComponent
// / Detail) into a more specific L2 class declared in `.data/ontologies/
// coding.lower.json` (LiveLoggingSystem, ConstraintMonitor, OnlineObservation,
// ...). When the LLM declines all L2 options OR the lower-onto file is absent
// from disk, we fall back to the L1 parent — no forced L2 classification, no
// synthetic emissions. This preserves the existing `'Unclassified'` fallback
// (line 523) intact.
//
// All three helpers are pure functions exported for unit testing; the agent
// class uses them via the instance field `this.l2Classes` populated at
// initialize() time.

/**
 * The L1 parent classes that can be refined to a more specific L2 in
 * coding.lower.json. Plan 02 D-09 locks this set: the 10 L2 classes extend
 * exactly these three carriers (6 Component + 3 Detail + 1 SubComponent).
 */
export const REFINABLE_L1_PARENTS: readonly string[] = [
  'Component',
  'SubComponent',
  'Detail',
];

/**
 * Filter a registry to classes whose `extends` chain anchors at one of the
 * REFINABLE_L1_PARENTS. Returns ResolvedClass[] (name + description + extends
 * + relationships + optional properties), ready for prompt rendering.
 *
 * Empty array when coding.lower.json is absent from the ontology directory —
 * the registry loads `upper.json` + `coding-ontology.json` without throwing,
 * and the L1 carriers themselves do NOT match this filter (Component extends
 * nothing in coding-ontology.json).
 */
export function loadL2Classes(registry: OntologyRegistry): ResolvedClass[] {
  const out: ResolvedClass[] = [];
  for (const cls of registry.classCatalog.values()) {
    // Skip the L1 carrier classes themselves (e.g. `Detail extends SubComponent`
    // in coding-ontology.json). Only TRUE L2 classes shipped in a *.lower.json
    // file should populate the refinement prompt.
    if (REFINABLE_L1_PARENTS.includes(cls.name)) continue;
    if (cls.extends && REFINABLE_L1_PARENTS.includes(cls.extends)) {
      out.push(cls);
    }
  }
  return out;
}

/**
 * Render the refinement-step prompt addendum for a given L1 class.
 * Returns the empty string when refinement is not applicable:
 *   - L1 class is not in REFINABLE_L1_PARENTS (e.g. Project, File, Service)
 *   - L2 class list is empty (coding.lower.json absent — graceful no-op)
 *
 * Wording matches Plan 04 Task 1 step 2 (planner-locked). Descriptions are
 * sourced from `cls.description` at render-time so prompt + JSON file stay
 * in sync — editing coding.lower.json's description propagates without code
 * change.
 */
export function buildL2RefinementPrompt(
  l1Class: string,
  l2Classes: readonly ResolvedClass[],
): string {
  if (!REFINABLE_L1_PARENTS.includes(l1Class)) return '';
  if (l2Classes.length === 0) return '';

  const lines: string[] = [];
  lines.push('');
  lines.push(
    'REFINEMENT STEP — if the L1 class is one of [Component, SubComponent, Detail], ' +
      'try to refine to a more specific L2 class from this list, otherwise return the ' +
      'L1 class unchanged. Decline (return L1) if none of these L2 classes fit the ' +
      'observation:',
  );
  for (const cls of l2Classes) {
    lines.push(`- ${cls.name}: ${cls.description}`);
  }
  return lines.join('\n');
}

/**
 * Parse the LLM's refinement response and validate against the registered L2
 * class set. Rejects hallucinated class names (not in `validL2Names`) and
 * falls back to the L1 parent in three cases:
 *   - empty / whitespace-only response
 *   - response equal to (or matching) the L1 parent itself
 *   - response not matching any registered L2 name
 *
 * Embedded matches are tolerated: the LLM may wrap the class name in a
 * sentence (e.g. "After consideration the class is EtmDaemon.") — the
 * first valid L2 name discovered wins. This preserves the no-forced-L2
 * invariant (D-10).
 */
export function extractL2FromLLMResponse(
  rawText: string,
  validL2Names: readonly string[],
  l1Fallback: string,
): string {
  const text = (rawText ?? '').trim();
  if (text.length === 0) return l1Fallback;

  // Token-boundary scan so 'EtmDaemon' inside a sentence resolves but
  // 'SuperEtmDaemonX' (a hallucinated near-miss) does not.
  for (const name of validL2Names) {
    const re = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegex(name)}([^A-Za-z0-9_]|$)`);
    if (re.test(text)) return name;
  }
  return l1Fallback;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Ontology metadata to be attached to entities
 */
export interface OntologyMetadata {
  /** Matched ontology class name */
  ontologyClass: string;

  /** Ontology version */
  ontologyVersion: string;

  /** Classification confidence (0-1) */
  classificationConfidence: number;

  /** Method used for classification */
  // Phase 60 D-14 — widen with 'hard-root-guard' so the writer-side guard's
  // short-circuit path can surface in telemetry (byMethod aggregation in
  // classifyObservations + dashboard sub-step badges).
  classificationMethod: 'heuristic' | 'llm' | 'hybrid' | 'auto-assigned' | 'unclassified' | 'hard-root-guard';

  /** Source ontology (upper or lower name) */
  ontologySource: 'upper' | 'lower';

  /** Properties extracted per ontology schema */
  properties: Record<string, any>;

  /** Timestamp of classification */
  classifiedAt: string;

  /** LLM usage for this classification (when method is 'llm' or 'hybrid') */
  llmUsage?: {
    model?: string;
    provider?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

/**
 * Observation with ontology classification
 */
export interface ClassifiedObservation {
  /** Original observation data */
  original: any;

  /** Ontology metadata */
  ontologyMetadata: OntologyMetadata;

  /** Whether classification was successful */
  classified: boolean;
}

/**
 * Result of classification process
 */
export interface ClassificationProcessResult {
  /** Successfully classified observations */
  classified: ClassifiedObservation[];

  /** Observations that couldn't be classified */
  unclassified: Array<{
    observation: any;
    reason: string;
    suggestedClass?: string;
  }>;

  /** Summary statistics */
  summary: {
    total: number;
    classifiedCount: number;
    unclassifiedCount: number;
    averageConfidence: number;
    byMethod: Record<string, number>;
    byClass: Record<string, number>;
    llmCalls?: number; // Number of LLM calls made during classification
    /** Aggregated LLM usage statistics */
    llmUsage?: {
      totalPromptTokens: number;
      totalCompletionTokens: number;
      totalTokens: number;
      modelsUsed: string[];
      providersUsed: string[];
    };
  };

  /** Auto-extension suggestions generated */
  extensionSuggestions: Array<{
    suggestedClassName: string;
    extendsClass: string;
    matchingObservations: string[];
    confidence: number;
  }>;
}

/**
 * Agent for classifying observations against ontology
 */
export class OntologyClassificationAgent {
  private configManager: OntologyConfigManager | null = null;
  // Phase 42-03: was the legacy ontology-load class; now the km-core registry adapter.
  private ontology: LegacyOntologyAdapter | null = null;
  private validator: OntologyValidator | null = null;
  private classifier: OntologyClassifier | null = null;
  private semanticAnalyzer: SemanticAnalyzer;
  private team: string;
  private basePath: string;
  private initialized: boolean = false;
  // Phase 57 Plan 04 D-10 — L2 classes loaded from coding.lower.json via
  // OntologyRegistry. Empty array when the lower-onto file is absent (graceful
  // degrade — L2 refinement is silently skipped, L1 emission preserved).
  private l2Classes: ResolvedClass[] = [];

  constructor(team: string = 'coding', repositoryPath?: string) {
    this.team = team;
    this.basePath = repositoryPath || process.env.KNOWLEDGE_BASE_PATH || process.cwd();
    this.semanticAnalyzer = new SemanticAnalyzer();
  }

  /**
   * Initialize the ontology system
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Create default config
      const defaultConfig: ExtendedOntologyConfig = {
        enabled: true,
        upperOntologyPath: path.join(
          this.basePath,
          '.data/ontologies/development-knowledge-ontology.json'
        ),
        lowerOntologyPath: path.join(
          this.basePath,
          `.data/ontologies/lower/${this.team}-ontology.json`
        ),
        team: this.team,
        validation: {
          mode: 'lenient',
          failOnError: false,
          allowUnknownProperties: true,
        },
        classification: {
          useUpper: true,
          useLower: true,
          minConfidence: 0.6,
          enableLLM: true,  // LLM enabled for semantic classification
          enableHeuristics: true,
          llmBudgetPerClassification: 500,
        },
        caching: {
          enabled: true,
          maxEntries: 100,
          ttl: 300000,
        },
        hotReload: false,
      };

      // Try to get existing config manager or create new one
      try {
        this.configManager = OntologyConfigManager.getInstance(defaultConfig);
      } catch {
        // Reset and try again (for testing scenarios)
        OntologyConfigManager.resetInstance();
        this.configManager = OntologyConfigManager.getInstance(defaultConfig);
      }

      // Initialize config manager
      await this.configManager.initialize();

      // Phase 42-03: construct km-core's OntologyRegistry directly. It does a
      // single-level scan of `.data/ontologies/` (flattened in Task 1 of this
      // plan). The Docker bind-mount maps the repo into `/coding` so a host-
      // path and a container-path both resolve via path.join(basePath,
      // '.data/ontologies').
      const config = this.configManager.getConfig();
      const ontologyDir = path.join(this.basePath, '.data/ontologies');
      const registry = new OntologyRegistry({ ontologyDir });
      this.ontology = new LegacyOntologyAdapter(registry);

      // Phase 57 Plan 04 D-10 — load the 10 L2 classes from coding.lower.json
      // (auto-discovered by the registry alongside upper.json + coding-ontology.json).
      // Empty array when coding.lower.json is absent — refinement is silently
      // skipped and L1 emission is preserved. Log the count to stderr so
      // operators can spot a regression (file missing / file malformed).
      this.l2Classes = loadL2Classes(registry);
      if (this.l2Classes.length === 0) {
        process.stderr.write(
          '[ontology-classification-agent] coding.lower.json not loaded — L2 refinement disabled\n',
        );
      } else {
        log('Phase 57-04: L2 refinement classes loaded', 'info', {
          count: this.l2Classes.length,
          names: this.l2Classes.map((c) => c.name),
        });
      }

      // Create validator and classifier (signatures unchanged — both now accept
      // LegacyOntologyAdapter where they used to accept the deleted legacy class).
      this.validator = new OntologyValidator(this.ontology);

      const heuristicClassifier = createHeuristicClassifier();

      // Create LLM inference engine using SemanticAnalyzer
      // Interface: generateCompletion({ messages, maxTokens, temperature }) => Promise<{ content, model, usage }>
      const llmInferenceEngine = {
        generateCompletion: async (options: { messages: Array<{ role: string; content: string }>; maxTokens?: number; temperature?: number }) => {
          try {
            // Extract the user message content (the prompt built by OntologyClassifier)
            const userMessage = options.messages.find(m => m.role === 'user');
            const prompt = userMessage?.content || '';

            log('LLM classification request received', 'debug', {
              promptLength: prompt.length,
              maxTokens: options.maxTokens,
              temperature: options.temperature,
            });

            const result = await this.semanticAnalyzer.analyzeContent(prompt, {
              analysisType: 'classification', // Pass prompt through unchanged for JSON response
              taskType: 'ontology_classification', // Routes to groq via task_provider_priority
              process: PROCESS_TAGS.WAVE3_ONTOLOGY_CLASSIFY,  // Phase 52 D-05 unconditional tagging
            });

            // The SemanticAnalyzer returns insights - extract the classification
            log('LLM classification completed', 'debug', {
              insightsLength: result.insights?.length || 0,
            });

            return {
              content: result.insights || '',
              // Use actual model from SemanticAnalyzer result (e.g., 'llama-3.3-70b-versatile')
              model: result.model || result.provider || 'unknown',
              // Include provider for proper tracking
              provider: result.provider,
              usage: {
                promptTokens: result.tokenUsage?.inputTokens || 0,
                completionTokens: result.tokenUsage?.outputTokens || 0,
                totalTokens: result.tokenUsage?.totalTokens || 0,
              },
            };
          } catch (error) {
            log('LLM classification failed', 'warning', error);
            throw error; // Let OntologyClassifier handle the error and fallback to heuristics
          }
        },
      };

      this.classifier = new OntologyClassifier(
        this.ontology,
        this.validator,
        heuristicClassifier,
        llmInferenceEngine as any
      );

      this.initialized = true;
      log('OntologyClassificationAgent initialized', 'info', { team: this.team });
    } catch (error) {
      log('Failed to initialize OntologyClassificationAgent', 'error', error);
      throw error;
    }
  }

  /**
   * Classify a batch of observations
   */
  async classifyObservations(params: {
    observations: any[];
    autoExtend?: boolean;
    minConfidence?: number;
  }): Promise<ClassificationProcessResult> {
    await this.initialize();

    const { observations = [], autoExtend = true, minConfidence = 0.6 } = params || {};

    // Handle case where observations is undefined or not an array
    const observationsList = Array.isArray(observations) ? observations : [];

    log('Classifying observations', 'info', {
      count: observationsList.length,
      autoExtend,
      minConfidence,
    });

    // If no observations, return empty result
    if (observationsList.length === 0) {
      log('No observations to classify - returning empty result', 'info');
      return {
        classified: [],
        unclassified: [],
        summary: {
          total: 0,
          classifiedCount: 0,
          unclassifiedCount: 0,
          averageConfidence: 0,
          byMethod: {},
          byClass: {},
        },
        extensionSuggestions: [],
      };
    }

    const classified: ClassifiedObservation[] = [];
    const unclassified: Array<{
      observation: any;
      reason: string;
      suggestedClass?: string;
    }> = [];

    const byMethod: Record<string, number> = {};
    const byClass: Record<string, number> = {};
    let totalConfidence = 0;

    // Process observations in parallel batches for speed
    // With groq (task_provider_priority), each LLM call takes ~1-2s vs copilot's ~15s
    // Higher batch size = more parallelism; memory-safe since prompts are small
    // Configurable via LLM_BATCH_SIZE env var (default: 10, min: 1, max: 30)
    const BATCH_SIZE = Math.min(Math.max(
      parseInt(process.env.LLM_BATCH_SIZE || '10', 10), 1
    ), 30);
    const batches: any[][] = [];
    for (let i = 0; i < observationsList.length; i += BATCH_SIZE) {
      batches.push(observationsList.slice(i, i + BATCH_SIZE));
    }

    // Memory monitoring helper
    const getMemoryMB = () => {
      const mem = process.memoryUsage();
      return {
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        rss: Math.round(mem.rss / 1024 / 1024),
        external: Math.round(mem.external / 1024 / 1024)
      };
    };

    const startMemory = getMemoryMB();
    log(`Processing ${observationsList.length} observations in ${batches.length} batches of ${BATCH_SIZE}`, 'info', {
      startMemory
    });

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const batchStartMemory = getMemoryMB();

      // Log memory every 5 batches or if heap is > 500MB
      if (batchIndex % 5 === 0 || batchStartMemory.heapUsed > 500) {
        log(`Batch ${batchIndex + 1}/${batches.length} memory check`, 'info', {
          memory: batchStartMemory,
          observations: batch.length
        });
      }

      // Process batch - use sequential processing if memory pressure is high
      const useSequential = batchStartMemory.heapUsed > 400; // 400MB threshold
      let batchResults: Array<{ success: boolean; result?: ClassifiedObservation; error?: any; observation: any }>;

      if (useSequential) {
        // Sequential processing to reduce memory pressure
        log(`High memory (${batchStartMemory.heapUsed}MB), using sequential processing`, 'warning');
        batchResults = [];
        for (const observation of batch) {
          try {
            const result = await this.classifySingleObservation(observation, minConfidence);
            batchResults.push({ success: true, result, observation });
          } catch (error) {
            log('Error classifying observation', 'warning', { error, observation: observation.name });
            batchResults.push({ success: false, error, observation });
          }
        }
      } else {
        // Parallel processing for speed
        batchResults = await Promise.all(
          batch.map(async (observation) => {
            try {
              const result = await this.classifySingleObservation(observation, minConfidence);
              return { success: true, result, observation };
            } catch (error) {
              log('Error classifying observation', 'warning', { error, observation: observation.name });
              return { success: false, error, observation };
            }
          })
        );
      }

      // Hint garbage collection between batches (if available)
      if (global.gc && batchIndex % 3 === 0) {
        global.gc();
      }

      // Collect results from batch
      for (const batchResult of batchResults) {
        if (batchResult.success && batchResult.result) {
          const result = batchResult.result;
          if (result.classified) {
            classified.push(result);
            totalConfidence += result.ontologyMetadata.classificationConfidence;

            // Track statistics
            const method = result.ontologyMetadata.classificationMethod;
            byMethod[method] = (byMethod[method] || 0) + 1;

            const className = result.ontologyMetadata.ontologyClass;
            byClass[className] = (byClass[className] || 0) + 1;
          } else {
            unclassified.push({
              observation: batchResult.observation,
              reason: 'No matching ontology class found',
              suggestedClass: this.suggestClass(batchResult.observation),
            });
          }
        } else {
          unclassified.push({
            observation: batchResult.observation,
            reason: batchResult.error instanceof Error ? batchResult.error.message : String(batchResult.error),
          });
        }
      }
    }

    // Generate extension suggestions for unclassified observations
    const extensionSuggestions = autoExtend
      ? await this.generateExtensionSuggestions(unclassified)
      : [];

    // Calculate LLM calls based on classification methods used
    // 'llm' method = 1 LLM call, 'hybrid' method = 1 LLM call (heuristic + LLM fallback)
    const llmCalls = (byMethod['llm'] || 0) + (byMethod['hybrid'] || 0);

    // Aggregate LLM usage stats from all classified observations
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    const modelsUsedSet = new Set<string>();
    const providersUsedSet = new Set<string>();

    for (const obs of classified) {
      const usage = obs.ontologyMetadata.llmUsage;
      if (usage) {
        totalPromptTokens += usage.promptTokens || 0;
        totalCompletionTokens += usage.completionTokens || 0;
        if (usage.model) modelsUsedSet.add(usage.model);
        if (usage.provider) providersUsedSet.add(usage.provider);
      }
    }

    const llmUsage = llmCalls > 0 ? {
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens: totalPromptTokens + totalCompletionTokens,
      modelsUsed: Array.from(modelsUsedSet),
      providersUsed: Array.from(providersUsedSet),
    } : undefined;

    const result: ClassificationProcessResult = {
      classified,
      unclassified,
      summary: {
        total: observationsList.length,
        classifiedCount: classified.length,
        unclassifiedCount: unclassified.length,
        averageConfidence: classified.length > 0 ? totalConfidence / classified.length : 0,
        byMethod,
        byClass,
        llmCalls, // Track LLM calls for dashboard visibility
        llmUsage, // Aggregated LLM usage statistics
      },
      extensionSuggestions,
    };

    // Log final memory state and change from start
    const endMemory = getMemoryMB();
    const memoryDelta = {
      heapUsed: endMemory.heapUsed - startMemory.heapUsed,
      rss: endMemory.rss - startMemory.rss
    };

    log('Classification complete', 'info', {
      ...result.summary,
      llmCalls,
      llmUsage,
      memoryEnd: endMemory,
      memoryDelta
    });

    return result;
  }

  /**
   * Classify a single observation
   */
  private async classifySingleObservation(
    observation: any,
    minConfidence: number
  ): Promise<ClassifiedObservation> {
    if (!this.classifier) {
      throw new Error('Classifier not initialized');
    }

    // Phase 60 D-14 — hard-root guard: closed-set of system + project
    // anchors (CollectiveKnowledge + Coding/DynArch/Timeline/Normalisa)
    // are immutable. The LLM re-classifier MUST NOT overwrite their
    // ontologyClass regardless of LLM verdict. Short-circuit BEFORE the
    // classifier is invoked so:
    //   (a) no LLM cost is incurred for hierarchy roots,
    //   (b) no LLM verdict can drift the class (D-12 root cause is the
    //       drift back to ontologyClass='Detail' on CollectiveKnowledge),
    //   (c) telemetry surfaces the short-circuit via the new
    //       'hard-root-guard' classificationMethod literal.
    //
    // Source of truth: HIERARCHY_ROOTS + HIERARCHY_ROOT_CLASS exported
    // from `@fwornle/km-core` (lib/km-core/src/types/hierarchy-roots.ts).
    // Pattern source: quality-assurance-agent.ts:1921 exemptNodes Set.
    const obsName = (observation as { name?: unknown } | null | undefined)?.name;
    if (isHierarchyRoot(obsName)) {
      const lockedClass = HIERARCHY_ROOT_CLASS[obsName];
      const ontologyMetadata: OntologyMetadata = {
        ontologyClass: lockedClass,
        ontologyVersion: '1.0.0',
        classificationConfidence: 1.0,
        classificationMethod: 'hard-root-guard',
        ontologySource: 'upper',
        properties: {},
        classifiedAt: new Date().toISOString(),
      };
      return {
        original: observation,
        ontologyMetadata,
        classified: true,
      };
    }

    // Build classification input from observation
    const classificationInput = this.buildClassificationInput(observation);

    // Perform classification
    const classificationResult: OntologyClassification | null = await this.classifier.classify(
      classificationInput,
      {
        team: this.team,
        minConfidence,
      }
    );

    // Handle unclassified (null result)
    if (!classificationResult) {
      const ontologyMetadata: OntologyMetadata = {
        ontologyClass: 'Unclassified',
        ontologyVersion: '1.0.0',
        classificationConfidence: 0,
        classificationMethod: 'unclassified',
        ontologySource: 'upper',
        properties: {},
        classifiedAt: new Date().toISOString(),
      };

      return {
        original: observation,
        ontologyMetadata,
        classified: false,
      };
    }

    // Build ontology metadata
    const ontologyMetadata: OntologyMetadata = {
      ontologyClass: classificationResult.entityClass,
      ontologyVersion: '1.0.0', // TODO: Get from ontology
      classificationConfidence: classificationResult.confidence,
      classificationMethod: classificationResult.method as any,
      ontologySource: classificationResult.ontology === this.team ? 'lower' : 'upper',
      properties: classificationResult.properties || {},
      classifiedAt: new Date().toISOString(),
      // Include LLM usage if available (for llm or hybrid classifications)
      llmUsage: classificationResult.llmUsage,
    };

    // Phase 60 Plan 09 (SC#5 / LOWERONTO-03) — deterministic L2 refinement.
    // When the classifier lands on a refinable L1 carrier (Component/SubComponent/
    // Detail), apply the closed-vocabulary keyword mapper to assign a parent-
    // consistent L2 sub-class. Local + deterministic (no LLM): supersedes the
    // Phase 57-04 LLM L2-refinement step for the L2 outcome. Hierarchy roots are
    // already short-circuited above (hard-root-guard) and never reach here.
    if (REFINABLE_L1_PARENTS.includes(ontologyMetadata.ontologyClass)) {
      const l2 = classifyL2(
        (observation as { name?: string } | null | undefined)?.name,
        (observation as { description?: string } | null | undefined)?.description,
        ontologyMetadata.ontologyClass,
      );
      if (l2) {
        ontologyMetadata.ontologyClass = l2;
        ontologyMetadata.ontologySource = 'lower';
        ontologyMetadata.classificationMethod = 'heuristic';
      }
    }

    return {
      original: observation,
      ontologyMetadata,
      classified: classificationResult.confidence >= minConfidence,
    };
  }

  /**
   * Build classification input string from observation
   *
   * Phase 57 Plan 04 D-10 — append the L2 refinement instruction as a separate
   * step after the observation content. The LLM sees both the L1 class catalog
   * (via OntologyClassifier.buildClassificationPrompt's `entityClasses`
   * enumeration) AND this REFINEMENT STEP instruction with one-line L2
   * descriptions. The model is instructed to decline (return L1) when no L2
   * class fits — no forced L2 classification (D-10 invariant).
   *
   * When `this.l2Classes` is empty (coding.lower.json absent or malformed),
   * buildL2RefinementPrompt returns the empty string and the input is unchanged
   * from the pre-Phase-57 behaviour — L1 emission preserved as a graceful
   * degradation.
   */
  private buildClassificationInput(observation: any): string {
    const parts: string[] = [];

    // Add name
    if (observation.name) {
      parts.push(`Name: ${observation.name}`);
    }

    // Add entity type
    if (observation.entityType) {
      parts.push(`Type: ${observation.entityType}`);
    }

    // Add observations content
    if (observation.observations && Array.isArray(observation.observations)) {
      const obsTexts = observation.observations
        .map((o: any) => (typeof o === 'string' ? o : o.content || ''))
        .filter(Boolean)
        .slice(0, 5); // Limit to first 5

      if (obsTexts.length > 0) {
        parts.push(`Content: ${obsTexts.join('; ')}`);
      }
    }

    // Add tags
    if (observation.tags && Array.isArray(observation.tags)) {
      parts.push(`Tags: ${observation.tags.join(', ')}`);
    }

    // Phase 57 Plan 04 D-10 — append the L2 refinement step. The helper
    // self-gates on the refinable-L1 set; we pass 'Component' here as a
    // probe-class so the L1 check passes whenever L2 classes are loaded.
    // The actual L1 → L2 decision happens inside the LLM's response to the
    // REFINEMENT STEP instruction.
    const refinement = buildL2RefinementPrompt('Component', this.l2Classes);
    if (refinement.length > 0) {
      parts.push(refinement);
    }

    return parts.join('\n');
  }

  /**
   * Suggest a class for an unclassified observation
   */
  private suggestClass(observation: any): string | undefined {
    const entityType = observation.entityType?.toLowerCase() || '';
    const name = observation.name?.toLowerCase() || '';

    // Pattern matching for common types (mapped to six-facet upper ontology)
    if (entityType.includes('service') || entityType.includes('component') || name.includes('component')) {
      return 'Service';
    }
    if (entityType.includes('pattern') || name.includes('pattern')) {
      return 'Service';
    }
    if (entityType.includes('file') || entityType.includes('artifact') || name.includes('artifact')) {
      return 'File';
    }
    if (entityType.includes('config') || name.includes('config')) {
      return 'Config';
    }
    if (entityType.includes('contract') || entityType.includes('integration') || name.includes('contract')) {
      return 'Contract';
    }
    if (entityType.includes('fault') || name.includes('fault') || name.includes('error')) {
      return 'Fault';
    }
    if (entityType.includes('limitation') || entityType.includes('constraint') || entityType.includes('insight')) {
      return 'Limitation';
    }
    if (entityType.includes('decision') || entityType.includes('revision') || name.includes('revision')) {
      return 'Revision';
    }
    if (entityType.includes('workflow') || entityType.includes('feature') || name.includes('feature')) {
      return 'Feature';
    }
    if (entityType.includes('process') || entityType.includes('execution')) {
      return 'Process';
    }

    return undefined;
  }

  /**
   * Generate extension suggestions from unclassified observations
   */
  private async generateExtensionSuggestions(
    unclassified: Array<{ observation: any; reason: string; suggestedClass?: string }>
  ): Promise<
    Array<{
      suggestedClassName: string;
      extendsClass: string;
      matchingObservations: string[];
      confidence: number;
    }>
  > {
    // Group unclassified by suggested class
    const groups: Map<string, any[]> = new Map();

    for (const item of unclassified) {
      const suggestedClass = item.suggestedClass || item.observation.entityType || 'Unknown';
      if (!groups.has(suggestedClass)) {
        groups.set(suggestedClass, []);
      }
      groups.get(suggestedClass)!.push(item.observation);
    }

    const suggestions: Array<{
      suggestedClassName: string;
      extendsClass: string;
      matchingObservations: string[];
      confidence: number;
    }> = [];

    // Generate suggestions for groups with 2+ members
    for (const [className, observations] of groups) {
      if (observations.length >= 2 && className !== 'Unknown') {
        suggestions.push({
          suggestedClassName: className.replace(/[^a-zA-Z0-9]/g, ''),
          extendsClass: this.determineParentClass(className),
          matchingObservations: observations.map((o) => o.name || 'unnamed'),
          confidence: Math.min(0.9, 0.5 + observations.length * 0.1),
        });
      }
    }

    // Save suggestions if any
    if (suggestions.length > 0) {
      await this.saveSuggestions(suggestions);
    }

    return suggestions;
  }

  /**
   * Determine parent class for a suggested class
   */
  private determineParentClass(className: string): string {
    const lowerName = className.toLowerCase();

    if (lowerName.includes('component') || lowerName.includes('module') || lowerName.includes('service')) {
      return 'Service';
    }
    if (lowerName.includes('pattern') || lowerName.includes('practice')) {
      return 'Service';
    }
    if (lowerName.includes('file') || lowerName.includes('artifact') || lowerName.includes('document')) {
      return 'File';
    }
    if (lowerName.includes('config') || lowerName.includes('setting')) {
      return 'Config';
    }
    if (lowerName.includes('contract') || lowerName.includes('metric') || lowerName.includes('measure') || lowerName.includes('integration')) {
      return 'Contract';
    }
    if (lowerName.includes('fault') || lowerName.includes('error') || lowerName.includes('failure')) {
      return 'Fault';
    }
    if (lowerName.includes('limitation') || lowerName.includes('constraint') || lowerName.includes('insight') || lowerName.includes('observation')) {
      return 'Limitation';
    }
    if (lowerName.includes('decision') || lowerName.includes('choice') || lowerName.includes('revision')) {
      return 'Revision';
    }
    if (lowerName.includes('workflow') || lowerName.includes('feature')) {
      return 'Feature';
    }
    if (lowerName.includes('process') || lowerName.includes('execution') || lowerName.includes('context')) {
      return 'Process';
    }

    return 'Service';
  }

  /**
   * Save extension suggestions to file
   */
  private async saveSuggestions(
    suggestions: Array<{
      suggestedClassName: string;
      extendsClass: string;
      matchingObservations: string[];
      confidence: number;
    }>
  ): Promise<void> {
    try {
      const suggestionsPath = path.join(
        this.basePath,
        '.data/ontologies/suggestions/pending-classes.json'
      );

      // Load existing
      let existing: any = { pending: [], metadata: { version: '1.0.0', lastUpdated: null } };
      try {
        const content = await fs.readFile(suggestionsPath, 'utf-8');
        existing = JSON.parse(content);
      } catch {
        // File doesn't exist yet
      }

      // Add new suggestions
      for (const suggestion of suggestions) {
        // Check if already exists
        const alreadyExists = existing.pending.some(
          (p: any) => p.suggestedClassName === suggestion.suggestedClassName
        );

        if (!alreadyExists) {
          existing.pending.push({
            id: `suggestion-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            ...suggestion,
            createdAt: new Date().toISOString(),
            status: 'pending',
          });
        }
      }

      existing.metadata.lastUpdated = new Date().toISOString();

      // Save
      await fs.mkdir(path.dirname(suggestionsPath), { recursive: true });
      await fs.writeFile(suggestionsPath, JSON.stringify(existing, null, 2));

      log('Saved extension suggestions', 'info', { count: suggestions.length });
    } catch (error) {
      log('Failed to save extension suggestions', 'warning', error);
    }
  }

  /**
   * Get classification statistics
   */
  getStatistics(): {
    initialized: boolean;
    team: string;
    ontologyLoaded: boolean;
    classesAvailable: number;
  } {
    return {
      initialized: this.initialized,
      team: this.team,
      ontologyLoaded: this.ontology !== null,
      classesAvailable: this.ontology?.getAllEntityClasses().length || 0,
    };
  }
}

export default OntologyClassificationAgent;
