/**
 * WaveController - Hierarchical Wave Orchestration Engine
 *
 * Replaces the flat batch-analysis DAG with sequential wave execution:
 *   Wave 1: L0 Project + L1 Component entities (manifest-driven)
 *   Wave 2: L2 SubComponent entities (manifest seeded + code discovery)
 *   Wave 3: L3 Detail entities (pure code discovery)
 *
 * Each wave produces parent nodes before the next wave spawns child-level agents.
 * Entities are persisted after each wave (crash-resilient).
 * Agents within a wave run in parallel, bounded by maxAgentsPerWave.
 *
 * @module agents/wave-controller
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { log } from '../logging.js';
import { loadComponentManifest, flattenManifestEntries, writeManifestDiscoveries } from '../types/component-manifest.js';
import type { DiscoveredManifestEntry } from '../types/component-manifest.js';
// Phase 42.2 Plan 04 — legacy GraphDatabaseAdapter retired.
// All persistence (read + write) routes through the km-core adapter.
import { createKmCoreAdapter, type KmCoreAdapter } from '../storage/km-core-adapter.js';
// Phase 42 Plan 07 Phase B1 — KM_CORE_PERSISTENCE feature flag REMOVED.
// km-core is now the unconditional persistence backend. Legacy graphDB writes
// (operator-bypass + per-wave persistEntities) have been deleted.
import { Wave1ProjectAgent } from './wave1-project-agent.js';
import { InsightGenerationAgent } from './insight-generation-agent.js';
import { OntologyClassificationAgent } from './ontology-classification-agent.js';
import type { CrossReferenceContext } from './insight-generation-agent.js';
// Phase 42.2 Plan 04 — type-only imports moved from the retired trio to
// the dependency-free `shared-memory-types.ts` module.
import type { GraphEntity, SharedMemoryEntity, EntityRelationship } from '../types/shared-memory-types.js';
import { createKGOperators } from './kg-operators.js';
import { SemanticAnalyzer } from './semantic-analyzer.js';
import { WorkflowReportAgent } from './workflow-report-agent.js';
import { QualityAssuranceAgent } from './quality-assurance-agent.js';
import type {
  TraceLLMCall,
  TraceAgentInstance,
  TraceEntityFlow,
  TraceQAResult,
  TraceCGRQuery,
} from '../trace-types.js';
import { CgrQueryCache } from '../services/cgr-query-cache.js';
import { CgrObservationBuilder } from '../utils/cgr-observation-builder.js';
import { DocumentationLinkerAgent } from './documentation-linker-agent.js';
import type { DocumentationAnalysisResult } from './documentation-linker-agent.js';
import { isMockLLMEnabled, getMockDelay } from '../mock/llm-mock-service.js';
import type { KGEntity, KGRelation, BatchContext } from './kg-operators.js';
import type { ComponentManifest } from '../types/component-manifest.js';
import type {
  WaveControllerConfig,
  WaveResult,
  WaveExecutionResult,
  WaveAgentOutput,
  ChildManifestEntry,
  Wave2Input,
  Wave3Input,
} from '../types/wave-types.js';
import { dispatch, getState } from '../workflow-state-machine.js';

/** Generic entity names that should be rejected -- too vague for a knowledge graph node */
const GENERIC_ENTITY_NAMES = new Set([
  'Component', 'SubComponent', 'Detail', 'Module', 'Service',
  'System', 'Manager', 'Handler', 'Processor', 'Helper',
  'Utils', 'Utility', 'Misc', 'Other', 'General', 'Main',
  'Core', 'Base', 'Abstract', 'Default', 'Common', 'Shared',
]);

/** PascalCase validation regex -- entity names must start with uppercase and contain only alphanumerics */
const PASCAL_CASE_REGEX = /^[A-Z][a-zA-Z0-9]*$/;

/** Interface for wave agents that expose LLM metrics */
interface WaveAgentWithMetrics {
  getLLMMetrics(): { providers: string[]; totalTokens: number; totalCalls: number };
  getDetailedCalls(): Array<{ provider: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number; latencyMs: number; operationType?: string; timestamp: number; promptPreview?: string; responsePreview?: string }>;
}

// ============================================================================
// WaveController
// ============================================================================

export class WaveController {
  private repositoryPath: string;
  private team: string;
  private progressFile: string;
  private maxAgentsPerWave: number;
  private failFast: boolean;
  /**
   * km-core strangler adapter (Phase 42 D-51).
   * Phase 42.2 Plan 04 — formerly optional alongside a legacy graphDB
   * fallback; now the unconditional persistence backend (the trio was
   * retired). Bootstrapped in execute() before any wave runs.
   */
  private kmCoreAdapter?: KmCoreAdapter;
  /** Caller-owned km-core store, when running in the owner's process. */
  private injectedKmStore?: object;
  private reportAgent: WorkflowReportAgent;
  private qaAgent: QualityAssuranceAgent;
  /** Per-step LLM metrics and outputs accumulated during execution */
  private stepMetrics: Map<string, {
    tokensUsed?: number;
    llmCalls?: number;
    llmProvider?: string;
    outputs?: Record<string, unknown>;
    llmCallEvents?: TraceLLMCall[];
    cgrQueryEvents?: TraceCGRQuery[];
    agentInstances?: TraceAgentInstance[];
    entityFlow?: TraceEntityFlow;
    qaResult?: TraceQAResult;
  }> = new Map();

  /** CGR query cache -- created at wave1_init, used by wave agents */
  private cgrCache: CgrQueryCache | null = null;
  /** Tracks which step is currently active for CGR query attribution */
  private currentCGRStep = 'wave1_analyze';
  /** CGR observation builder -- created at wave1_init, used by wave agents */
  private cgrBuilder: CgrObservationBuilder | null = null;
  /** Documentation analysis result -- populated during wave1_init, passed to wave agents */
  private docAnalysis: DocumentationAnalysisResult | null = null;
  /** Track all entity names persisted across waves — used for cross-wave parent validation */
  private persistedEntityNames: Set<string> = new Set();
  /** Phase 42 Plan 06 — stable runId for the current `ukb full` invocation.
   *  Stamped on every entity emitted by wave1/wave2/wave3 via
   *  `canonical-mapper.toCanonicalEntity`. Initialized at the start of
   *  `execute()` (matches the existing executionId pattern at line ~546). */
  private runId: string = `wave-analysis-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  constructor(config: WaveControllerConfig) {
    this.repositoryPath = config.repositoryPath;
    this.team = config.team;
    this.progressFile = config.progressFile;
    this.maxAgentsPerWave = config.maxAgentsPerWave ?? 4;
    this.failFast = config.failFast ?? true;
    this.injectedKmStore = config.kmStore;

    // Phase 42.2 Plan 04 — km-core adapter is bootstrapped inside execute()
    // (it requires an async store.open()). this.kmCoreAdapter is undefined
    // until then; no legacy GraphDatabaseAdapter exists anymore.
    this.reportAgent = new WorkflowReportAgent(this.repositoryPath);
    this.qaAgent = new QualityAssuranceAgent(this.repositoryPath, this.team);
  }

  /** Update lastUpdate timestamp and live metrics in progress file */
  private touchProgress(): void {
    try {
      const now = new Date().toISOString();
      const content = fs.readFileSync(this.progressFile, 'utf-8');
      const data = JSON.parse(content);
      data.lastUpdate = now;
      if (data.progress) {
        data.progress.lastUpdate = now;
      }

      // Flush live step metrics into stepsDetail for the tracer UI
      // stepsDetail entries are only created on step-complete, so we must create
      // a running-wave entry if it doesn't exist yet.
      if (!data.stepsDetail) data.stepsDetail = [];
      const waveNames = ['wave1', 'wave2', 'wave3', 'wave4'];
      for (const waveName of waveNames) {
        // Check if any metrics exist for this wave
        let tokens = 0, calls = 0;
        const providers = new Set<string>();
        const subSteps: Array<Record<string, unknown>> = [];
        for (const [key, entry] of this.stepMetrics.entries()) {
          if (!key.startsWith(waveName + '_') && key !== waveName) continue;
          const e = entry as any;
          if (e.tokensUsed) tokens += e.tokensUsed;
          if (e.llmCalls) calls += e.llmCalls;
          if (e.llmProvider) for (const p of e.llmProvider.split(', ')) providers.add(p);
          subSteps.push({ name: key, status: e.outputs ? 'completed' : 'running', ...e });
        }
        if (calls === 0 && subSteps.length === 0) continue;

        // Find or create the stepsDetail entry
        let step = data.stepsDetail.find((s: any) => s.name === waveName);
        if (!step) {
          step = { name: waveName, status: 'running', subSteps: [] };
          data.stepsDetail.push(step);
        }
        // Only update non-completed waves (don't overwrite final metrics)
        if (step.status === 'completed') continue;
        step.tokensUsed = tokens || undefined;
        step.llmCalls = calls || undefined;
        step.llmProvider = providers.size > 0 ? [...providers].join(', ') : undefined;
        step.subSteps = subSteps;
      }

      fs.writeFileSync(this.progressFile, JSON.stringify(data, null, 2));
    } catch {
      // Non-fatal
    }
  }

  /** Get the CGR query cache for downstream wave agents */
  getCgrCache(): CgrQueryCache | null {
    return this.cgrCache;
  }

  /** Get the CGR observation builder for downstream wave agents */
  getCgrBuilder(): CgrObservationBuilder | null {
    return this.cgrBuilder;
  }

  /**
   * Format doc analysis results as a compact context string for LLM prompts.
   * Returns null when no analysis is available or it produced nothing useful.
   */
  private formatDocContext(): string | undefined {
    if (!this.docAnalysis || this.docAnalysis.statistics.totalDocuments === 0) {
      return undefined;
    }
    const { documents, statistics } = this.docAnalysis;
    const docList = documents
      .slice(0, 20)
      .map(d => `- ${d.path}${d.title ? ` ("${d.title}")` : ''} [${d.type}]`)
      .join('\n');
    const moreCount = documents.length > 20 ? ` (and ${documents.length - 20} more)` : '';
    return `## Project Documentation (${statistics.totalDocuments} files, ${statistics.totalLinks} code references)\n${docList}${moreCount}\n\nKey documented components: ${statistics.unresolvedReferences.slice(0, 10).join(', ')}`;
  }

  /** Capture LLM metrics from SemanticAnalyzer for a step and store outputs */
  private captureStepMetrics(stepName: string, outputs?: Record<string, unknown>): void {
    const metrics = SemanticAnalyzer.getStepMetrics();
    SemanticAnalyzer.resetStepMetrics();
    // Convert per-call records into TraceLLMCall format for UI drill-down
    const llmCallEvents: TraceLLMCall[] = metrics.calls.map(c => ({
      id: crypto.randomUUID(),
      model: c.model || 'unknown',
      provider: c.provider,
      purpose: stepName,
      durationMs: 0,
      tokensIn: c.inputTokens,
      tokensOut: c.outputTokens,
      status: 'success' as const,
      promptPreview: c.promptPreview,
      responsePreview: c.responsePreview,
    }));
    this.stepMetrics.set(stepName, {
      tokensUsed: metrics.totalTokens || undefined,
      llmCalls: metrics.totalCalls || undefined,
      llmProvider: metrics.providers?.join(', ') || undefined,
      llmCallEvents: llmCallEvents.length > 0 ? llmCallEvents : undefined,
      outputs,
    });
    // Immediately flush to progress file so tracer shows live substep data
    this.touchProgress();
  }

  /**
   * Patch a substep's `outputs` field in-place — merges with existing
   * outputs, preserves the running tally of llmCalls/tokensUsed that
   * captureStepMetrics will write at substep completion. Use this for
   * in-flight progress emissions (e.g. wave4 insight generation
   * ticking "12/51 generated" upward) — calling captureStepMetrics
   * incrementally would discard the running LLM metric counters.
   */
  private updateStepOutputs(stepName: string, outputs: Record<string, unknown>): void {
    const existing = this.stepMetrics.get(stepName) ?? {};
    const mergedOutputs = { ...((existing as any).outputs ?? {}), ...outputs };
    this.stepMetrics.set(stepName, { ...existing, outputs: mergedOutputs });
    this.touchProgress();
  }

  private lastProgressEmitTs = 0;
  private progressItemsSinceEmit = 0;
  private readonly PROGRESS_EMIT_EVERY_N = 5;
  private readonly PROGRESS_EMIT_MIN_MS = 2000;

  /**
   * Throttled per-item progress emission (D-13).
   * Routes through wave-controller's OWN writer path (updateStepOutputs → touchProgress → fs.writeFileSync).
   * Does NOT touch coordinator's existing-progress preservation (Phase 42.2-02 single-writer invariant).
   * See workflow-runner.ts:469-530 for the Phase 10 race-condition zone this bypasses.
   */
  private maybeEmitItemProgress(stepName: string, completed: number, total: number): void {
    this.progressItemsSinceEmit += 1;
    const now = Date.now();
    const dueByCount = this.progressItemsSinceEmit >= this.PROGRESS_EMIT_EVERY_N;
    const dueByTime = now - this.lastProgressEmitTs >= this.PROGRESS_EMIT_MIN_MS;
    if (dueByCount || dueByTime || completed === total) {
      this.updateStepOutputs(stepName, { itemsCompleted: completed, itemsTotal: total });
      this.progressItemsSinceEmit = 0;
      this.lastProgressEmitTs = now;
    }
  }

  private resetItemProgressThrottle(): void {
    this.lastProgressEmitTs = 0;
    this.progressItemsSinceEmit = 0;
  }

  /** Capture LLM metrics directly from a wave agent's getLLMMetrics() */
  private captureAgentMetrics(stepName: string, agentMetrics: { providers: string[]; totalTokens: number; totalCalls: number }, outputs?: Record<string, unknown>): void {
    this.stepMetrics.set(stepName, {
      tokensUsed: agentMetrics.totalTokens || undefined,
      llmCalls: agentMetrics.totalCalls || undefined,
      llmProvider: agentMetrics.providers.join(', ') || undefined,
      outputs,
    });
    // Immediately flush to progress file so tracer shows live substep data
    this.touchProgress();
  }

  // --------------------------------------------------------------------------
  // Trace Capture Methods (fire-and-forget, never throw)
  // --------------------------------------------------------------------------

  /** Capture an individual LLM call event for a step */
  captureLLMCallEvent(stepName: string, call: TraceLLMCall): void {
    try {
      let entry = this.stepMetrics.get(stepName);
      if (!entry) {
        entry = {};
        this.stepMetrics.set(stepName, entry);
      }
      if (!entry.llmCallEvents) {
        entry.llmCallEvents = [];
      }
      entry.llmCallEvents.push(call);
    } catch (e) {
      log('[WaveController] Failed to capture LLM call event (non-fatal)', 'debug', {
        stepName, error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Capture a CGR query event for a step */
  captureCGRQueryEvent(stepName: string, event: TraceCGRQuery): void {
    try {
      let entry = this.stepMetrics.get(stepName);
      if (!entry) {
        entry = {};
        this.stepMetrics.set(stepName, entry);
      }
      if (!entry.cgrQueryEvents) {
        entry.cgrQueryEvents = [];
      }
      entry.cgrQueryEvents.push(event);
    } catch (e) {
      log('[WaveController] Failed to capture CGR query event (non-fatal)', 'debug', {
        stepName, error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Capture entity flow counters for a step */
  captureEntityFlow(stepName: string, flow: TraceEntityFlow): void {
    try {
      let entry = this.stepMetrics.get(stepName);
      if (!entry) {
        entry = {};
        this.stepMetrics.set(stepName, entry);
      }
      entry.entityFlow = flow;
    } catch (e) {
      log('[WaveController] Failed to capture entity flow (non-fatal)', 'debug', {
        stepName, error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Capture QA validation result for a step */
  captureQAResult(stepName: string, result: TraceQAResult): void {
    try {
      let entry = this.stepMetrics.get(stepName);
      if (!entry) {
        entry = {};
        this.stepMetrics.set(stepName, entry);
      }
      entry.qaResult = result;
    } catch (e) {
      log('[WaveController] Failed to capture QA result (non-fatal)', 'debug', {
        stepName, error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Convert LLMCallMetrics from @rapid/llm-proxy into TraceLLMCall format */
  private convertLLMMetricsToCalls(
    calls: Array<{ provider: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number; latencyMs: number; operationType?: string; timestamp: number; promptPreview?: string; responsePreview?: string }>,
  ): TraceLLMCall[] {
    return calls.map(c => ({
      id: crypto.randomUUID(),
      model: c.model,
      provider: c.provider,
      purpose: c.operationType || 'llm_call',
      durationMs: c.latencyMs,
      tokensIn: c.inputTokens,
      tokensOut: c.outputTokens,
      status: 'success' as const,
      promptPreview: c.promptPreview,
      responsePreview: c.responsePreview,
    }));
  }

  /** Capture an agent instance for a step */
  captureAgentInstance(stepName: string, instance: TraceAgentInstance): void {
    try {
      let entry = this.stepMetrics.get(stepName);
      if (!entry) {
        entry = {};
        this.stepMetrics.set(stepName, entry);
      }
      if (!entry.agentInstances) {
        entry.agentInstances = [];
      }
      entry.agentInstances.push(instance);
    } catch (e) {
      log('[WaveController] Failed to capture agent instance (non-fatal)', 'debug', {
        stepName, error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Extract TraceLLMCall events from entities' _traceData and capture them.
   * Converts the per-entity EntityTraceData into TraceLLMCall format.
   */
  private captureEntityTraceData(stepName: string, entities: KGEntity[]): void {
    try {
      for (const entity of entities) {
        const traceArr = (entity as any)._traceData as Array<{
          llmCallCount: number; totalDurationMs: number;
          model: string; provider: string; agentType: string;
        }> | undefined;
        if (!traceArr) continue;
        for (const trace of traceArr) {
          this.captureLLMCallEvent(stepName, {
            id: crypto.randomUUID(),
            model: trace.model,
            provider: trace.provider,
            purpose: trace.agentType,
            durationMs: trace.totalDurationMs,
            tokensIn: 0,  // Not tracked at entity level
            tokensOut: 0,
            status: 'success',
          });
        }
      }
    } catch (e) {
      log('[WaveController] Failed to extract entity trace data (non-fatal)', 'debug', {
        stepName, error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // --------------------------------------------------------------------------
  // Main entry point
  // --------------------------------------------------------------------------

  async execute(): Promise<WaveExecutionResult> {
    const startTime = Date.now();
    const waveResults: WaveResult[] = [];

    // Global heartbeat: update lastUpdate every 5s for live tracer substep updates
    const globalHeartbeat = setInterval(() => this.touchProgress(), 5_000);
    // Initial touch
    this.touchProgress();

    /** Aggregate all sub-step metrics (e.g. wave1_init, wave1_analyze, wave1_qa)
     *  into a single combined metrics object for the wave-level step-complete event */
    const aggregateWaveMetrics = (wavePrefix: string) => {
      let totalTokens = 0;
      let totalCalls = 0;
      const providers = new Set<string>();
      const allLLMCallEvents: TraceLLMCall[] = [];
      const allCGRQueryEvents: TraceCGRQuery[] = [];
      const allAgentInstances: TraceAgentInstance[] = [];
      let entityFlow: TraceEntityFlow | undefined;
      let qaResult: TraceQAResult | undefined;

      for (const [key, entry] of this.stepMetrics.entries()) {
        if (!key.startsWith(wavePrefix + '_') && key !== wavePrefix) continue;
        if (entry.tokensUsed) totalTokens += entry.tokensUsed;
        if (entry.llmCalls) totalCalls += entry.llmCalls;
        if (entry.llmProvider) {
          for (const p of entry.llmProvider.split(', ')) providers.add(p);
        }
        if (entry.llmCallEvents) {
          allLLMCallEvents.push(...entry.llmCallEvents);
        }
        if (entry.cgrQueryEvents) {
          allCGRQueryEvents.push(...entry.cgrQueryEvents);
        }
        if (entry.agentInstances) {
          allAgentInstances.push(...entry.agentInstances);
        }
        // Use the last entityFlow/qaResult found (persist/qa sub-steps)
        if (entry.entityFlow) entityFlow = entry.entityFlow;
        if (entry.qaResult) qaResult = entry.qaResult;
      }

      return {
        tokensUsed: totalTokens || undefined,
        llmCalls: totalCalls || undefined,
        llmProvider: providers.size > 0 ? [...providers].join(', ') : undefined,
        llmCallEvents: allLLMCallEvents.length > 0 ? allLLMCallEvents as unknown as Array<Record<string, unknown>> : undefined,
        cgrQueryEvents: allCGRQueryEvents.length > 0 ? allCGRQueryEvents as unknown as Array<Record<string, unknown>> : undefined,
        agentInstances: allAgentInstances.length > 0 ? allAgentInstances as unknown as Array<Record<string, unknown>> : undefined,
        entityFlow: entityFlow as unknown as Record<string, unknown> | undefined,
        qaResult: qaResult as unknown as Record<string, unknown> | undefined,
      };
    };

    /** Build enriched step-complete event with aggregated sub-step metrics */
    const buildStepComplete = (stepName: string, nextStep: string, waveNum: number, waveStartTime: number) => {
      const metrics = aggregateWaveMetrics(stepName);
      // Collect individual sub-step entries for trace drill-down
      const subSteps: Array<Record<string, unknown>> = [];
      for (const [key, entry] of this.stepMetrics.entries()) {
        if (!key.startsWith(stepName + '_') && key !== stepName) continue;
        subSteps.push({
          name: key,
          status: 'completed',
          ...entry,
        });
      }
      return {
        type: 'step-complete' as const,
        stepName,
        nextStep,
        duration: Math.round((Date.now() - waveStartTime) / 1000),
        wave: waveNum,
        tokensUsed: metrics.tokensUsed,
        llmCalls: metrics.llmCalls,
        llmProvider: metrics.llmProvider,
        agentInstances: metrics.agentInstances,
        llmCallEvents: metrics.llmCallEvents,
        cgrQueryEvents: metrics.cgrQueryEvents,
        entityFlow: metrics.entityFlow,
        qaResult: metrics.qaResult,
        subSteps: subSteps.length > 0 ? subSteps : undefined,
      };
    };

    try {
      // === Phase 42 Plan 07 Phase B1 — km-core adapter unconditional ===
      // === Phase 42.2 Plan 04 — legacy GraphDatabaseAdapter retired ===
      // The KM_CORE_PERSISTENCE feature flag was removed in Phase 42-07 B1
      // and the legacy graphDB read-path was retired in Phase 42.2 Plan 04.
      // km-core is now the only persistence backend; bootstrap is mandatory
      // and any failure aborts the wave run.
      //
      // dbPath/exportDir point at .data/knowledge-graph/{leveldb,exports}
      // — the canonical store after Phase 42.2 Plan 05's atomic dir-swap.
      // (Pre-swap, this pointed at .data/knowledge-graph-migrated/ as a
      // Phase 42-07 Phase A transitional measure; Plan 05 collapsed the two
      // dirs into the single canonical location and reverted this path.)
      try {
        if (this.injectedKmStore) {
          // In-process run inside the store's owner (obs-api). The store is
          // already open and stays open after we finish — do NOT open or close
          // it here. See WaveControllerConfig.kmStore for why this exists.
          this.kmCoreAdapter = createKmCoreAdapter({
            store: this.injectedKmStore as never,
            team: this.team,
          });
          log('[WaveController] km-core adapter initialized (caller-owned store)', 'info', {
            owner: 'injected',
          });
        } else {
          const km = await import('@fwornle/km-core');
          const dbPath = path.join(this.repositoryPath, '.data', 'knowledge-graph', 'leveldb');
          const exportDir = path.join(this.repositoryPath, '.data', 'knowledge-graph', 'exports');
          const ontologyDir = path.join(this.repositoryPath, '.data', 'ontologies');
          const store = new km.GraphKMStore({
            dbPath,
            exportDir,
            ontologyDir,
            domains: [this.team],
            debounceMs: 5000,
          });
          await store.open();
          this.kmCoreAdapter = createKmCoreAdapter({ store, team: this.team });
          log('[WaveController] km-core adapter initialized (private store)', 'info', {
            dbPath, exportDir, ontologyDir,
          });
        }
      } catch (e) {
        // Bootstrap failure is now fatal — the legacy persistence-agent path
        // was removed in Phase B1. Surface to the caller so the workflow
        // dispatcher can transition to `failed` instead of running silently
        // against an unconfigured backend.
        log('[WaveController] km-core adapter bootstrap failed (fatal — no legacy fallback)', 'error', {
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }

      // Load component manifest
      const manifest = loadComponentManifest();
      const flatEntries = flattenManifestEntries(manifest);
      log('[WaveController] Component manifest loaded', 'info', {
        components: manifest.components.length,
        totalEntries: flatEntries.length,
      });

      // Load existing KG entities for context enrichment
      const existingEntities = await this.loadExistingEntities();
      // Seed persisted entity names from existing graph (for cross-wave parent validation)
      for (const e of existingEntities) {
        this.persistedEntityNames.add(e.name);
      }
      log('[WaveController] Existing entities loaded', 'info', {
        count: existingEntities.length,
        seededNames: this.persistedEntityNames.size,
      });

      // Start workflow report for history
      const executionId = `wave-analysis-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      // Phase 42 Plan 06 — stable runId shared with wave1/wave2/wave3 agents
      // for canonical-mapper provenance + descriptionSegments stamping.
      this.runId = executionId;
      this.reportAgent.startWorkflowReport('wave-analysis', executionId, { team: this.team });

      // ---- Wave 1: L0 Project + L1 Components ----
      this.logWaveBanner('WAVE 1', 'L0 Project + L1 Components');
      // Pause BEFORE wave1 init (first pause of workflow)
      await this.checkSingleStepPause('wave1_init', false);
      dispatch({ type: 'substep-update', substepId: 'wave1_init', wave: 1, totalWaves: 4 });

      // Initialize CGR query cache and start async index refresh
      this.cgrCache = new CgrQueryCache(this.repositoryPath, (event) => {
        this.captureCGRQueryEvent(this.currentCGRStep, event);
      });
      this.cgrBuilder = new CgrObservationBuilder();
      if (isMockLLMEnabled(this.repositoryPath)) {
        log('[WaveController] Mock mode: skipping CGR index refresh', 'info');
      } else {
        log('[WaveController] CGR index refresh started (30s timeout)', 'info');
        await this.cgrCache.refreshIndex(30_000);
      }
      if (!this.cgrCache.isAvailable()) {
        log('[WaveController] CGR unavailable -- continuing with LLM-only observations', 'warning');
      }

      this.captureStepMetrics('wave1_init', {
        manifestEntries: flatEntries.length,
        existingEntities: existingEntities.length,
        cgrAvailable: this.cgrCache.isAvailable(),
      });

      // Documentation analysis: scan .md and .puml files for project context
      dispatch({ type: 'substep-update', substepId: 'wave1_docs', wave: 1, totalWaves: 4 });
      try {
        const docLinker = new DocumentationLinkerAgent(this.repositoryPath);
        this.docAnalysis = await docLinker.analyzeDocumentation();
        log('[WaveController] Documentation analysis complete', 'info', {
          documents: this.docAnalysis.statistics.totalDocuments,
          links: this.docAnalysis.statistics.totalLinks,
        });
        this.captureStepMetrics('wave1_docs', {
          documents: this.docAnalysis.statistics.totalDocuments,
          links: this.docAnalysis.statistics.totalLinks,
          unresolvedReferences: this.docAnalysis.statistics.unresolvedReferences,
        });
      } catch (err) {
        log('[WaveController] Documentation analysis failed (non-fatal)', 'warning', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.docAnalysis = null;
        this.captureStepMetrics('wave1_docs', { error: err instanceof Error ? err.message : 'unknown' });
      }

      // Pause BEFORE analyze (user sees "about to analyze wave1")
      await this.checkSingleStepPause('wave1_analyze', false);
      this.currentCGRStep = 'wave1_analyze';
      SemanticAnalyzer.resetStepMetrics();
      dispatch({ type: 'substep-update', substepId: 'wave1_analyze', wave: 1, totalWaves: 4 });
      let { result: wave1Result, agent: wave1Agent } = await this.executeWave1WithMetrics(manifest, existingEntities);
      waveResults.push(wave1Result);
      const cgrStatsOutput = this.cgrCache ? { cgrStats: this.cgrCache.getStats() } : {};
      if (wave1Agent) {
        this.captureAgentMetrics('wave1_analyze', wave1Agent.getLLMMetrics(), { totalEntities: wave1Result.totalEntities, discoveredEntities: wave1Result.discoveredEntities, ...cgrStatsOutput });
      } else {
        this.captureStepMetrics('wave1_analyze', { totalEntities: wave1Result.totalEntities, discoveredEntities: wave1Result.discoveredEntities, ...cgrStatsOutput });
      }

      // Capture trace data from Wave 1 entities
      if (wave1Result.success) {
        const w1Entities = wave1Result.agentOutputs.flatMap(o => o.entities);
        this.captureEntityTraceData('wave1_analyze', w1Entities);
        this.captureEntityFlow('wave1_analyze', {
          produced: w1Entities.length,
          passedQA: 0,
          persisted: 0,
        });
        // Capture Wave 1 agent as a single instance
        if (wave1Agent) {
          this.captureAgentInstance('wave1_analyze', {
            agentId: 'wave1_agent_project',
            agentType: 'Wave1ProjectAgent',
            parentEntity: 'Project',
            startTime: new Date(startTime).toISOString(),
            endTime: new Date().toISOString(),
            status: 'completed',
            llmCalls: this.convertLLMMetricsToCalls(wave1Agent.getDetailedCalls()),
            entityCount: w1Entities.length,
            observationCount: w1Entities.reduce((sum, e) => sum + (e.observations?.length || 0), 0),
          });
        }
      }

      if (!wave1Result.success) {
        log('[WaveController] Wave 1 failed', 'error', { error: wave1Result.error });
        if (this.failFast) {
          return this.buildSummaryReport(startTime, waveResults);
        }
      } else {
        let wave1Entities = wave1Result.agentOutputs.flatMap(o => o.entities);

        // Pause BEFORE QA
        await this.checkSingleStepPause('wave1_qa', false);
        dispatch({ type: 'substep-update', substepId: 'wave1_qa', wave: 1, totalWaves: 4 });

        // QA gate: validate wave 1 output
        const wave1QaEntities = wave1Entities.map(e => ({ name: e.name, observations: e.observations || [], type: e.type || 'Unclassified', level: e.level }));
        const wave1QaReport = await this.qaAgent.validateWaveOutput('wave1_analyze', wave1QaEntities);
        log('[WaveController] QA validation', 'info', {
          wave: 1,
          passed: wave1QaReport.passed,
          score: wave1QaReport.score,
          errors: wave1QaReport.errors.length,
          warnings: wave1QaReport.warnings.length,
        });
        this.captureStepMetrics('wave1_qa', { passed: wave1QaReport.passed, score: wave1QaReport.score });
        // Capture QA trace result
        this.captureQAResult('wave1_analyze', {
          passed: wave1QaReport.passed,
          score: wave1QaReport.score,
          errors: wave1QaReport.errors.length > 0 ? wave1QaReport.errors : undefined,
        });

        // QA retry: if score < 60, retry wave 1 once with feedback
        // Skip retry in mock mode — mock entities always fail QA (short generic observations)
        if (!isMockLLMEnabled(this.repositoryPath) && !wave1QaReport.passed && wave1QaReport.score < 60) {
          log('[WaveController] QA retry triggered', 'info', {
            wave: 1,
            score: wave1QaReport.score,
            errors: wave1QaReport.errors.length,
          });
          dispatch({ type: 'substep-update', substepId: 'wave1_qa_retry', wave: 1, totalWaves: 4 });
          await new Promise(r => setTimeout(r, 50));

          const { result: retryResult, retried } = await this.retryWaveWithFeedback(
            1,
            wave1QaReport.errors,
            wave1Entities,
            async () => {
              const { result } = await this.executeWave1WithMetrics(manifest, existingEntities);
              return result;
            },
          );

          if (retried) {
            const retryEntities = retryResult.agentOutputs.flatMap(o => o.entities);
            const retryQaEntities = retryEntities.map(e => ({ name: e.name, observations: e.observations || [], type: e.type || 'Unclassified', level: e.level }));
            const retryQA = await this.qaAgent.validateWaveOutput('wave1_retry', retryQaEntities);
            log('[WaveController] QA retry result', 'info', {
              wave: 1,
              passed: retryQA.passed,
              score: retryQA.score,
              improved: retryQA.score > wave1QaReport.score,
            });
            this.captureStepMetrics('wave1_qa_retry', { passed: retryQA.passed, score: retryQA.score, originalScore: wave1QaReport.score });

            if (retryQA.score > wave1QaReport.score) {
              wave1Result = retryResult;
              wave1Entities = retryResult.agentOutputs.flatMap(o => o.entities);
              log('[WaveController] Using retry result for wave 1 (improved)', 'info', {
                originalScore: wave1QaReport.score,
                retryScore: retryQA.score,
              });
            } else {
              log('[WaveController] Keeping original wave 1 result (retry did not improve)', 'warning', {
                originalScore: wave1QaReport.score,
                retryScore: retryQA.score,
              });
            }
          }
        } else if (isMockLLMEnabled(this.repositoryPath) && !wave1QaReport.passed) {
          log('[WaveController] Mock mode: skipping QA retry (mock entities always fail QA)', 'info', {
            wave: 1, score: wave1QaReport.score,
          });
        }

        // Update entity flow: passedQA count
        this.captureEntityFlow('wave1_analyze', {
          produced: wave1Entities.length,
          passedQA: wave1Entities.length,
          persisted: 0,
        });

        // Ontology classification — pause at macro step first, then sub-steps
        await this.checkSingleStepPause('wave1_classify', false);
        dispatch({ type: 'substep-update', substepId: 'wave1_classify', wave: 1, totalWaves: 4 });

        // Sub-step 1: Data preparation (match entities to ontology classes)
        await this.checkSingleStepPause('onto_data_prep', true);
        SemanticAnalyzer.resetStepMetrics();
        dispatch({ type: 'substep-update', substepId: 'onto_data_prep', wave: 1, totalWaves: 4 });
        await new Promise(r => setTimeout(r, 100));

        // Sub-step 2: LLM classification
        await this.checkSingleStepPause('onto_llm_classify', true);
        dispatch({ type: 'substep-update', substepId: 'onto_llm_classify', wave: 1, totalWaves: 4 });
        let w1ClassifyIdx = 0;
        const wave1ClassifyTasks = wave1Entities.map(entity => async () => {
          await this.classifyEntity(entity);
          w1ClassifyIdx++;
          this.maybeEmitItemProgress('wave1_classify', w1ClassifyIdx, wave1Entities.length);
        });
        this.resetItemProgressThrottle();
        await this.runWithConcurrency(wave1ClassifyTasks, 2);

        // Sub-step 3: Apply classification results
        await this.checkSingleStepPause('onto_apply_results', true);
        dispatch({ type: 'substep-update', substepId: 'onto_apply_results', wave: 1, totalWaves: 4 });
        this.captureStepMetrics('wave1_classify', { entitiesClassified: wave1Entities.length });
        log('[WaveController] Wave 1 classification complete', 'info', { entities: wave1Entities.length });

        // Pause BEFORE persist
        await this.checkSingleStepPause('wave1_persist', false);
        dispatch({ type: 'substep-update', substepId: 'wave1_persist', wave: 1, totalWaves: 4 });
        await new Promise(r => setTimeout(r, 100));
        if (isMockLLMEnabled(this.repositoryPath)) {
          const mockDelay = getMockDelay(this.repositoryPath);
          await new Promise(r => setTimeout(r, mockDelay));
          log('[WaveController] Mock mode: skipping wave 1 persist', 'info');
        } else {
          await this.persistWaveResult(wave1Result);
        }
        this.captureStepMetrics('wave1_persist', { entitiesPersisted: wave1Result.totalEntities });
        // Update entity flow: persisted count
        this.captureEntityFlow('wave1_analyze', {
          produced: wave1Entities.length,
          passedQA: wave1Entities.length,
          persisted: wave1Result.totalEntities,
        });
        log('[WaveController] Wave 1 entities persisted', 'info', {
          entities: wave1Result.totalEntities,
        });
      }

      // Signal wave 1 completion to state machine
      dispatch(buildStepComplete('wave1', 'wave2', 1, startTime));
      // No macro pause between waves — the next wave's first step pause is sufficient

      // ---- Wave 2: L2 SubComponents ----
      if (getState().status === 'cancelled') {
        process.stderr.write('[WaveController] Workflow cancelled, stopping execution\n');
        return this.buildSummaryReport(startTime, waveResults);
      }
      this.logWaveBanner('WAVE 2', 'L2 SubComponents');
      // Pause BEFORE wave2 analyze
      await this.checkSingleStepPause('wave2_analyze', false);
      this.currentCGRStep = 'wave2_analyze';
      SemanticAnalyzer.resetStepMetrics();
      dispatch({ type: 'substep-update', substepId: 'wave2_analyze', wave: 2, totalWaves: 4 });

      let { result: wave2Result, agents: wave2Agents } = await this.executeWave2WithMetrics(wave1Result, manifest);
      waveResults.push(wave2Result);
      {
        // Aggregate metrics from all Wave 2 agents
        const allProviders = new Set<string>();
        let totalTokens = 0, totalCalls = 0;
        for (const agent of wave2Agents) {
          const m = agent.getLLMMetrics();
          m.providers.forEach(p => allProviders.add(p));
          totalTokens += m.totalTokens;
          totalCalls += m.totalCalls;
        }
        const cgrStatsW2 = this.cgrCache ? { cgrStats: this.cgrCache.getStats() } : {};
        this.captureAgentMetrics('wave2_analyze', { providers: [...allProviders], totalTokens, totalCalls }, { totalEntities: wave2Result.totalEntities, discoveredEntities: wave2Result.discoveredEntities, ...cgrStatsW2 });
      }

      // Capture trace data from Wave 2 entities and agent instances
      if (wave2Result.success) {
        const w2Entities = wave2Result.agentOutputs.flatMap(o => o.entities);
        this.captureEntityTraceData('wave2_analyze', w2Entities);
        this.captureEntityFlow('wave2_analyze', {
          produced: w2Entities.length,
          passedQA: 0,
          persisted: 0,
        });
        // Agent instances already captured incrementally during runWithConcurrency
      }

      if (!wave2Result.success) {
        log('[WaveController] Wave 2 failed', 'error', { error: wave2Result.error });
        if (this.failFast) {
          return this.buildSummaryReport(startTime, waveResults);
        }
      } else {
        let wave2Entities = wave2Result.agentOutputs.flatMap(o => o.entities);

        // Pause BEFORE QA
        await this.checkSingleStepPause('wave2_qa', false);
        dispatch({ type: 'substep-update', substepId: 'wave2_qa', wave: 2, totalWaves: 4 });

        // QA gate: validate wave 2 output
        const wave2QaEntities = wave2Entities.map(e => ({ name: e.name, observations: e.observations || [], type: e.type || 'Unclassified', level: e.level }));
        const wave2QaReport = await this.qaAgent.validateWaveOutput('wave2_analyze', wave2QaEntities);
        log('[WaveController] QA validation', 'info', {
          wave: 2,
          passed: wave2QaReport.passed,
          score: wave2QaReport.score,
          errors: wave2QaReport.errors.length,
          warnings: wave2QaReport.warnings.length,
        });
        this.captureStepMetrics('wave2_qa', { passed: wave2QaReport.passed, score: wave2QaReport.score });
        // Capture QA trace result
        this.captureQAResult('wave2_analyze', {
          passed: wave2QaReport.passed,
          score: wave2QaReport.score,
          errors: wave2QaReport.errors.length > 0 ? wave2QaReport.errors : undefined,
        });

        // QA retry: if score < 60, retry wave 2 once with feedback
        // Skip retry in mock mode — mock entities always fail QA (short generic observations)
        if (!isMockLLMEnabled(this.repositoryPath) && !wave2QaReport.passed && wave2QaReport.score < 60) {
          log('[WaveController] QA retry triggered', 'info', {
            wave: 2,
            score: wave2QaReport.score,
            errors: wave2QaReport.errors.length,
          });
          dispatch({ type: 'substep-update', substepId: 'wave2_qa_retry', wave: 2, totalWaves: 4 });
          await new Promise(r => setTimeout(r, 50));

          const { result: retryResult, retried } = await this.retryWaveWithFeedback(
            2,
            wave2QaReport.errors,
            wave2Entities,
            async () => {
              const { result } = await this.executeWave2WithMetrics(wave1Result, manifest);
              return result;
            },
          );

          if (retried) {
            const retryEntities = retryResult.agentOutputs.flatMap(o => o.entities);
            const retryQaEntities = retryEntities.map(e => ({ name: e.name, observations: e.observations || [], type: e.type || 'Unclassified', level: e.level }));
            const retryQA = await this.qaAgent.validateWaveOutput('wave2_retry', retryQaEntities);
            log('[WaveController] QA retry result', 'info', {
              wave: 2,
              passed: retryQA.passed,
              score: retryQA.score,
              improved: retryQA.score > wave2QaReport.score,
            });
            this.captureStepMetrics('wave2_qa_retry', { passed: retryQA.passed, score: retryQA.score, originalScore: wave2QaReport.score });

            if (retryQA.score > wave2QaReport.score) {
              wave2Result = retryResult;
              wave2Entities = retryResult.agentOutputs.flatMap(o => o.entities);
              log('[WaveController] Using retry result for wave 2 (improved)', 'info', {
                originalScore: wave2QaReport.score,
                retryScore: retryQA.score,
              });
            } else {
              log('[WaveController] Keeping original wave 2 result (retry did not improve)', 'warning', {
                originalScore: wave2QaReport.score,
                retryScore: retryQA.score,
              });
            }
          }
        } else if (isMockLLMEnabled(this.repositoryPath) && !wave2QaReport.passed) {
          log('[WaveController] Mock mode: skipping QA retry (mock entities always fail QA)', 'info', {
            wave: 2, score: wave2QaReport.score,
          });
        }

        // Update entity flow: passedQA count
        this.captureEntityFlow('wave2_analyze', {
          produced: wave2Entities.length,
          passedQA: wave2Entities.length,
          persisted: 0,
        });

        if (getState().status === 'cancelled') {
          process.stderr.write('[WaveController] Workflow cancelled, stopping execution\n');
          return this.buildSummaryReport(startTime, waveResults);
        }
        // Ontology classification — pause at macro step first, then sub-steps
        await this.checkSingleStepPause('wave2_classify', false);
        dispatch({ type: 'substep-update', substepId: 'wave2_classify', wave: 2, totalWaves: 4 });

        await this.checkSingleStepPause('onto_data_prep', true);
        SemanticAnalyzer.resetStepMetrics();
        dispatch({ type: 'substep-update', substepId: 'onto_data_prep', wave: 2, totalWaves: 4 });
        await new Promise(r => setTimeout(r, 100));

        await this.checkSingleStepPause('onto_llm_classify', true);
        dispatch({ type: 'substep-update', substepId: 'onto_llm_classify', wave: 2, totalWaves: 4 });
        let w2ClassifyIdx = 0;
        const wave2ClassifyTasks = wave2Entities.map(entity => async () => {
          await this.classifyEntity(entity);
          w2ClassifyIdx++;
          this.maybeEmitItemProgress('wave2_classify', w2ClassifyIdx, wave2Entities.length);
        });
        this.resetItemProgressThrottle();
        await this.runWithConcurrency(wave2ClassifyTasks, 2);

        await this.checkSingleStepPause('onto_apply_results', true);
        dispatch({ type: 'substep-update', substepId: 'onto_apply_results', wave: 2, totalWaves: 4 });
        this.captureStepMetrics('wave2_classify', { entitiesClassified: wave2Entities.length });
        log('[WaveController] Wave 2 classification complete', 'info', { entities: wave2Entities.length });

        // Pause BEFORE persist
        await this.checkSingleStepPause('wave2_persist', false);
        dispatch({ type: 'substep-update', substepId: 'wave2_persist', wave: 2, totalWaves: 4 });
        await new Promise(r => setTimeout(r, 100));
        if (isMockLLMEnabled(this.repositoryPath)) {
          const mockDelay = getMockDelay(this.repositoryPath);
          await new Promise(r => setTimeout(r, mockDelay));
          log('[WaveController] Mock mode: skipping wave 2 persist', 'info');
        } else {
          await this.persistWaveResult(wave2Result);
        }
        this.captureStepMetrics('wave2_persist', { entitiesPersisted: wave2Result.totalEntities });
        // Update entity flow: persisted count
        this.captureEntityFlow('wave2_analyze', {
          produced: wave2Entities.length,
          passedQA: wave2Entities.length,
          persisted: wave2Result.totalEntities,
        });
        log('[WaveController] Wave 2 entities persisted', 'info', {
          entities: wave2Result.totalEntities,
        });
      }

      // Signal wave 2 completion to state machine
      dispatch(buildStepComplete('wave2', 'wave3', 2, startTime));

      // ---- Wave 3: L3 Details ----
      if (getState().status === 'cancelled') {
        process.stderr.write('[WaveController] Workflow cancelled, stopping execution\n');
        return this.buildSummaryReport(startTime, waveResults);
      }
      this.logWaveBanner('WAVE 3', 'L3 Detail Entities');
      // Pause BEFORE wave3 analyze
      await this.checkSingleStepPause('wave3_analyze', false);
      this.currentCGRStep = 'wave3_analyze';
      SemanticAnalyzer.resetStepMetrics();
      dispatch({ type: 'substep-update', substepId: 'wave3_analyze', wave: 3, totalWaves: 4 });

      let { result: wave3Result, agents: wave3Agents } = await this.executeWave3WithMetrics(wave2Result, manifest);
      waveResults.push(wave3Result);
      {
        const allProviders = new Set<string>();
        let totalTokens = 0, totalCalls = 0;
        for (const agent of wave3Agents) {
          const m = agent.getLLMMetrics();
          m.providers.forEach(p => allProviders.add(p));
          totalTokens += m.totalTokens;
          totalCalls += m.totalCalls;
        }
        const cgrStatsW3 = this.cgrCache ? { cgrStats: this.cgrCache.getStats() } : {};
        this.captureAgentMetrics('wave3_analyze', { providers: [...allProviders], totalTokens, totalCalls }, { totalEntities: wave3Result.totalEntities, discoveredEntities: wave3Result.discoveredEntities, ...cgrStatsW3 });
      }

      // Capture trace data from Wave 3 entities and agent instances
      if (wave3Result.success) {
        const w3Entities = wave3Result.agentOutputs.flatMap(o => o.entities);
        this.captureEntityTraceData('wave3_analyze', w3Entities);
        this.captureEntityFlow('wave3_analyze', {
          produced: w3Entities.length,
          passedQA: 0,
          persisted: 0,
        });
        // Agent instances already captured incrementally during runWithConcurrency
      }

      if (!wave3Result.success) {
        log('[WaveController] Wave 3 failed', 'error', { error: wave3Result.error });
      } else {
        let wave3Entities = wave3Result.agentOutputs.flatMap(o => o.entities);

        // Pause BEFORE QA
        await this.checkSingleStepPause('wave3_qa', false);
        dispatch({ type: 'substep-update', substepId: 'wave3_qa', wave: 3, totalWaves: 4 });

        // QA gate: validate wave 3 output
        const wave3QaEntities = wave3Entities.map(e => ({ name: e.name, observations: e.observations || [], type: e.type || 'Unclassified', level: e.level }));
        const wave3QaReport = await this.qaAgent.validateWaveOutput('wave3_analyze', wave3QaEntities);
        log('[WaveController] QA validation', 'info', {
          wave: 3,
          passed: wave3QaReport.passed,
          score: wave3QaReport.score,
          errors: wave3QaReport.errors.length,
          warnings: wave3QaReport.warnings.length,
        });
        this.captureStepMetrics('wave3_qa', { passed: wave3QaReport.passed, score: wave3QaReport.score });
        // Capture QA trace result
        this.captureQAResult('wave3_analyze', {
          passed: wave3QaReport.passed,
          score: wave3QaReport.score,
          errors: wave3QaReport.errors.length > 0 ? wave3QaReport.errors : undefined,
        });

        // QA retry: if score < 60, retry wave 3 once with feedback
        // Skip retry in mock mode — mock entities always fail QA (short generic observations)
        if (!isMockLLMEnabled(this.repositoryPath) && !wave3QaReport.passed && wave3QaReport.score < 60) {
          log('[WaveController] QA retry triggered', 'info', {
            wave: 3,
            score: wave3QaReport.score,
            errors: wave3QaReport.errors.length,
          });
          dispatch({ type: 'substep-update', substepId: 'wave3_qa_retry', wave: 3, totalWaves: 4 });
          await new Promise(r => setTimeout(r, 50));

          const { result: retryResult, retried } = await this.retryWaveWithFeedback(
            3,
            wave3QaReport.errors,
            wave3Entities,
            async () => {
              const { result } = await this.executeWave3WithMetrics(wave2Result, manifest);
              return result;
            },
          );

          if (retried) {
            const retryEntities = retryResult.agentOutputs.flatMap(o => o.entities);
            const retryQaEntities = retryEntities.map(e => ({ name: e.name, observations: e.observations || [], type: e.type || 'Unclassified', level: e.level }));
            const retryQA = await this.qaAgent.validateWaveOutput('wave3_retry', retryQaEntities);
            log('[WaveController] QA retry result', 'info', {
              wave: 3,
              passed: retryQA.passed,
              score: retryQA.score,
              improved: retryQA.score > wave3QaReport.score,
            });
            this.captureStepMetrics('wave3_qa_retry', { passed: retryQA.passed, score: retryQA.score, originalScore: wave3QaReport.score });

            if (retryQA.score > wave3QaReport.score) {
              wave3Result = retryResult;
              wave3Entities = retryResult.agentOutputs.flatMap(o => o.entities);
              log('[WaveController] Using retry result for wave 3 (improved)', 'info', {
                originalScore: wave3QaReport.score,
                retryScore: retryQA.score,
              });
            } else {
              log('[WaveController] Keeping original wave 3 result (retry did not improve)', 'warning', {
                originalScore: wave3QaReport.score,
                retryScore: retryQA.score,
              });
            }
          }
        } else if (isMockLLMEnabled(this.repositoryPath) && !wave3QaReport.passed) {
          log('[WaveController] Mock mode: skipping QA retry (mock entities always fail QA)', 'info', {
            wave: 3, score: wave3QaReport.score,
          });
        }

        // Update entity flow: passedQA count
        this.captureEntityFlow('wave3_analyze', {
          produced: wave3Entities.length,
          passedQA: wave3Entities.length,
          persisted: 0,
        });

        if (getState().status === 'cancelled') {
          process.stderr.write('[WaveController] Workflow cancelled, stopping execution\n');
          return this.buildSummaryReport(startTime, waveResults);
        }
        // Ontology classification — pause at macro step first, then sub-steps
        await this.checkSingleStepPause('wave3_classify', false);
        dispatch({ type: 'substep-update', substepId: 'wave3_classify', wave: 3, totalWaves: 4 });

        await this.checkSingleStepPause('onto_data_prep', true);
        SemanticAnalyzer.resetStepMetrics();
        dispatch({ type: 'substep-update', substepId: 'onto_data_prep', wave: 3, totalWaves: 4 });
        await new Promise(r => setTimeout(r, 100));

        await this.checkSingleStepPause('onto_llm_classify', true);
        dispatch({ type: 'substep-update', substepId: 'onto_llm_classify', wave: 3, totalWaves: 4 });
        let w3ClassifyIdx = 0;
        const wave3ClassifyTasks = wave3Entities.map(entity => async () => {
          await this.classifyEntity(entity);
          w3ClassifyIdx++;
          this.maybeEmitItemProgress('wave3_classify', w3ClassifyIdx, wave3Entities.length);
        });
        this.resetItemProgressThrottle();
        await this.runWithConcurrency(wave3ClassifyTasks, 2);

        await this.checkSingleStepPause('onto_apply_results', true);
        dispatch({ type: 'substep-update', substepId: 'onto_apply_results', wave: 3, totalWaves: 4 });
        this.captureStepMetrics('wave3_classify', { entitiesClassified: wave3Entities.length });
        log('[WaveController] Wave 3 classification complete', 'info', { entities: wave3Entities.length });

        // Pause BEFORE persist
        await this.checkSingleStepPause('wave3_persist', false);
        dispatch({ type: 'substep-update', substepId: 'wave3_persist', wave: 3, totalWaves: 4 });
        await new Promise(r => setTimeout(r, 100));
        if (isMockLLMEnabled(this.repositoryPath)) {
          const mockDelay = getMockDelay(this.repositoryPath);
          await new Promise(r => setTimeout(r, mockDelay));
          log('[WaveController] Mock mode: skipping wave 3 persist', 'info');
        } else {
          await this.persistWaveResult(wave3Result);
        }
        this.captureStepMetrics('wave3_persist', { entitiesPersisted: wave3Result.totalEntities });
        // Update entity flow: persisted count
        this.captureEntityFlow('wave3_analyze', {
          produced: wave3Entities.length,
          passedQA: wave3Entities.length,
          persisted: wave3Result.totalEntities,
        });
        log('[WaveController] Wave 3 entities persisted', 'info', {
          entities: wave3Result.totalEntities,
        });
      }

      // ---- Manifest Write-Back: Persist discovered L2 entities to YAML ----
      try {
        const discoveries: DiscoveredManifestEntry[] = [];
        // Collect discovered L2 entities from Wave 2 results
        for (const output of wave2Result.agentOutputs) {
          for (const entity of output.entities) {
            if (entity.level === 2 && entity.id?.startsWith('discovered:')) {
              discoveries.push({
                name: entity.name,
                parentL1: entity.parentId ?? '',
                description: entity.observations[0] ?? `SubComponent ${entity.name}`,
                keywords: [entity.name.toLowerCase()],
              });
            }
          }
        }

        if (discoveries.length > 0) {
          const added = writeManifestDiscoveries(discoveries);
          log('[WaveController] Manifest write-back complete', 'info', {
            discovered: discoveries.length,
            newlyAdded: added,
          });
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log('[WaveController] Manifest write-back failed (non-fatal)', 'warning', { error: errMsg });
      }

      // ---- KG Operators: Post-persistence refinement ----
      this.logWaveBanner('KG OPERATORS', 'Post-Persistence Refinement (6 operators)');
      try {
        // Collect all entities and relations from all 3 waves
        let allEntities: KGEntity[] = waveResults.flatMap(wr => wr.agentOutputs.flatMap(o => o.entities));
        let allRelations: KGRelation[] = waveResults.flatMap(wr => wr.agentOutputs.flatMap(o => o.relationships));

        log('[WaveController] KG Operators: collected entities/relations', 'info', {
          entities: allEntities.length,
          relations: allRelations.length,
        });

        // Build BatchContext
        const batchContext: BatchContext = {
          batchId: `wave-run-${Date.now()}`,
          startDate: new Date(startTime),
          endDate: new Date(),
          commits: await this.getRecentGitCommits(30),
          sessions: this.getRecentSessions(30),
        };

        // Create KGOperators instance
        const kgOperators = createKGOperators(new SemanticAnalyzer());
        const accumulatedKG = { entities: [] as KGEntity[], relations: [] as KGRelation[] }; // full-replace mode

        let currentEntities = allEntities;
        let currentRelations = allRelations;

        // Preserve ontology metadata from per-wave classification before operators strip it
        const ontologyMap = new Map<string, any>();
        for (const entity of allEntities) {
          const meta = (entity as any)._ontologyMetadata;
          if (meta) {
            ontologyMap.set(entity.name, meta);
          }
        }

        // --- Run each operator with full trace logging and SSE visibility ---
        const operatorTimings: Record<string, number> = {};

        if (getState().status === 'cancelled') {
          process.stderr.write('[WaveController] Workflow cancelled, stopping execution\n');
          return this.buildSummaryReport(startTime, waveResults);
        }

        // Mock mode: skip all KG operators (they do real graph work, not LLM calls)
        const mockOperators = isMockLLMEnabled(this.repositoryPath);

        // Conv
        await this.checkSingleStepPause('operator_conv', true);
        dispatch({ type: 'substep-update', substepId: 'operator_conv', wave: 3, totalWaves: 4 });
        await new Promise(r => setTimeout(r, 100)); // Allow SSE broadcast
        try {
          if (mockOperators) {
            await new Promise(r => setTimeout(r, getMockDelay(this.repositoryPath)));
            log('[WaveController] Mock mode: skipping Conv operator', 'info');
            operatorTimings.conv = getMockDelay(this.repositoryPath);
          } else {
            const convStart = Date.now();
            const convInputCount = currentEntities.length;
            currentEntities = await kgOperators.contextConvolution(currentEntities, batchContext);
            operatorTimings.conv = Date.now() - convStart;
            const withContext = currentEntities.filter(e => e.enrichedContext).length;
            log('[WaveController] OPERATOR TRACE: Conv complete', 'info', {
              inputEntities: convInputCount, outputEntities: currentEntities.length,
              withEnrichedContext: withContext, durationMs: operatorTimings.conv,
            });
            this.captureAgentMetrics('operator_conv', { providers: [], totalTokens: 0, totalCalls: 0 }, {
              inputEntities: convInputCount, outputEntities: currentEntities.length,
              withEnrichedContext: withContext, durationMs: operatorTimings.conv,
            });
          }
        } catch (e) { log('[WaveController] Conv operator FAILED', 'error', { error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }); }

        // Aggr
        await this.checkSingleStepPause('operator_aggr', true);
        dispatch({ type: 'substep-update', substepId: 'operator_aggr', wave: 3, totalWaves: 4 });
        await new Promise(r => setTimeout(r, 100));
        try {
          if (mockOperators) {
            await new Promise(r => setTimeout(r, getMockDelay(this.repositoryPath)));
            log('[WaveController] Mock mode: skipping Aggr operator', 'info');
            operatorTimings.aggr = getMockDelay(this.repositoryPath);
          } else {
            const aggrStart = Date.now();
            const aggrInputCount = currentEntities.length;
            const aggr = await kgOperators.entityAggregation(currentEntities);
            currentEntities = [...aggr.core, ...aggr.nonCore];
            operatorTimings.aggr = Date.now() - aggrStart;
            log('[WaveController] OPERATOR TRACE: Aggr complete', 'info', {
              inputEntities: aggrInputCount, core: aggr.core.length, nonCore: aggr.nonCore.length,
              durationMs: operatorTimings.aggr,
            });
            this.captureAgentMetrics('operator_aggr', { providers: [], totalTokens: 0, totalCalls: 0 }, {
              inputEntities: aggrInputCount, core: aggr.core.length, nonCore: aggr.nonCore.length,
              durationMs: operatorTimings.aggr,
            });
          }
        } catch (e) { log('[WaveController] Aggr operator FAILED', 'error', { error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }); }

        // Embed
        await this.checkSingleStepPause('operator_embed', true);
        dispatch({ type: 'substep-update', substepId: 'operator_embed', wave: 3, totalWaves: 4 });
        await new Promise(r => setTimeout(r, 100));
        try {
          if (mockOperators) {
            await new Promise(r => setTimeout(r, getMockDelay(this.repositoryPath)));
            log('[WaveController] Mock mode: skipping Embed operator', 'info');
            operatorTimings.embed = getMockDelay(this.repositoryPath);
          } else {
            const embedStart = Date.now();
            const embedInputCount = currentEntities.length;
            const beforeEmbCount = currentEntities.filter(e => e.embedding && e.embedding.length > 0).length;
            currentEntities = await kgOperators.nodeEmbedding(currentEntities);
            operatorTimings.embed = Date.now() - embedStart;
            const afterEmbCount = currentEntities.filter(e => e.embedding && e.embedding.length > 0).length;
            const sampleEmb = currentEntities.find(e => e.embedding && e.embedding.length > 0);
            log('[WaveController] OPERATOR TRACE: Embed complete', 'info', {
              inputEntities: embedInputCount, embeddingsBefore: beforeEmbCount, embeddingsAfter: afterEmbCount,
              newEmbeddings: afterEmbCount - beforeEmbCount, durationMs: operatorTimings.embed,
              sampleDimensions: sampleEmb?.embedding?.length ?? 0,
              sampleEntity: sampleEmb?.name ?? 'none',
            });
            this.captureAgentMetrics('operator_embed', { providers: [], totalTokens: 0, totalCalls: 0 }, {
              inputEntities: embedInputCount, embeddingsBefore: beforeEmbCount, embeddingsAfter: afterEmbCount,
              newEmbeddings: afterEmbCount - beforeEmbCount, durationMs: operatorTimings.embed,
            });
          }
        } catch (e) { log('[WaveController] Embed operator FAILED', 'error', { error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }); }

        // Dedup
        await this.checkSingleStepPause('operator_dedup', true);
        dispatch({ type: 'substep-update', substepId: 'operator_dedup', wave: 3, totalWaves: 4 });
        await new Promise(r => setTimeout(r, 100));
        try {
          if (mockOperators) {
            await new Promise(r => setTimeout(r, getMockDelay(this.repositoryPath)));
            log('[WaveController] Mock mode: skipping Dedup operator', 'info');
            operatorTimings.dedup = getMockDelay(this.repositoryPath);
          } else {
            const dedupStart = Date.now();
            const dedupInputCount = currentEntities.length;
            const deduped = await kgOperators.deduplication(currentEntities, accumulatedKG);
            operatorTimings.dedup = Date.now() - dedupStart;
            log('[WaveController] OPERATOR TRACE: Dedup complete', 'info', {
              inputEntities: dedupInputCount, outputEntities: deduped.entities.length,
              merged: deduped.merged, durationMs: operatorTimings.dedup,
              mergeLog: deduped.mergeLog.slice(0, 5),
            });
            currentEntities = deduped.entities;
            this.captureAgentMetrics('operator_dedup', { providers: [], totalTokens: 0, totalCalls: 0 }, {
              inputEntities: dedupInputCount, outputEntities: deduped.entities.length,
              merged: deduped.merged, durationMs: operatorTimings.dedup,
            });
          }
        } catch (e) { log('[WaveController] Dedup operator FAILED', 'error', { error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }); }

        // Pred
        await this.checkSingleStepPause('operator_pred', true);
        dispatch({ type: 'substep-update', substepId: 'operator_pred', wave: 3, totalWaves: 4 });
        await new Promise(r => setTimeout(r, 100));
        try {
          if (mockOperators) {
            await new Promise(r => setTimeout(r, getMockDelay(this.repositoryPath)));
            log('[WaveController] Mock mode: skipping Pred operator', 'info');
            operatorTimings.pred = getMockDelay(this.repositoryPath);
          } else {
            const predStart = Date.now();
            const relsBefore = currentRelations.length;
            const predicted = await kgOperators.edgePrediction(currentEntities, { entities: currentEntities, relations: currentRelations });
            operatorTimings.pred = Date.now() - predStart;
            log('[WaveController] OPERATOR TRACE: Pred complete', 'info', {
              inputEntities: currentEntities.length, relationsBefore: relsBefore,
              predictedEdges: predicted.edges.length, durationMs: operatorTimings.pred,
              topScores: predicted.scores.slice(0, 3).map(s => ({ from: s.from, to: s.to, score: s.score.toFixed(3) })),
            });
            currentRelations = [...currentRelations, ...predicted.edges];
            this.captureAgentMetrics('operator_pred', { providers: [], totalTokens: 0, totalCalls: 0 }, {
              inputEntities: currentEntities.length, relationsBefore: relsBefore,
              predictedEdges: predicted.edges.length, durationMs: operatorTimings.pred,
            });
          }
        } catch (e) { log('[WaveController] Pred operator FAILED', 'error', { error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }); }

        // Merge (structure fusion)
        await this.checkSingleStepPause('operator_merge', true);
        dispatch({ type: 'substep-update', substepId: 'operator_merge', wave: 3, totalWaves: 4 });
        await new Promise(r => setTimeout(r, 100));
        try {
          if (mockOperators) {
            await new Promise(r => setTimeout(r, getMockDelay(this.repositoryPath)));
            log('[WaveController] Mock mode: skipping Merge operator', 'info');
            operatorTimings.merge = getMockDelay(this.repositoryPath);
          } else {
            const mergeStart = Date.now();
            const merged = await kgOperators.structureMerge(
              { entities: currentEntities, relations: currentRelations },
              accumulatedKG
            );
            operatorTimings.merge = Date.now() - mergeStart;
            log('[WaveController] OPERATOR TRACE: Merge complete', 'info', {
              inputEntities: currentEntities.length, inputRelations: currentRelations.length,
              outputEntities: merged.entities.length, outputRelations: merged.relations.length,
              added: merged.added, updated: merged.updated, durationMs: operatorTimings.merge,
            });
            currentEntities = merged.entities;
            currentRelations = merged.relations;
            this.captureAgentMetrics('operator_merge', { providers: [], totalTokens: 0, totalCalls: 0 }, {
              inputEntities: currentEntities.length, inputRelations: currentRelations.length,
              outputEntities: merged.entities.length, outputRelations: merged.relations.length,
              added: merged.added, updated: merged.updated, durationMs: operatorTimings.merge,
            });
          }
        } catch (e) { log('[WaveController] Merge operator FAILED', 'error', { error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }); }

        // Log operator pipeline summary
        const totalOperatorTime = Object.values(operatorTimings).reduce((s, t) => s + t, 0);
        const embCount = currentEntities.filter(e => e.embedding && e.embedding.length > 0).length;
        const roleCount = currentEntities.filter(e => e.role).length;
        const ctxCount = currentEntities.filter(e => e.enrichedContext).length;
        log('[WaveController] === OPERATOR PIPELINE SUMMARY ===', 'info', {
          totalEntities: currentEntities.length, totalRelations: currentRelations.length,
          withEmbeddings: embCount, withRole: roleCount, withEnrichedContext: ctxCount,
          totalDurationMs: totalOperatorTime, operatorTimings,
        });

        // Re-attach ontology metadata that operators may have stripped
        for (const entity of currentEntities) {
          if (!(entity as any)._ontologyMetadata && ontologyMap.has(entity.name)) {
            (entity as any)._ontologyMetadata = ontologyMap.get(entity.name);
          }
        }

        // === DIRECT GRAPH WRITE for operator-enriched fields ===
        // In mock mode, skip direct graph write and re-persist
        if (mockOperators) {
          log('[WaveController] Mock mode: skipping direct graph write and re-persist', 'info');
        } else {
        // Bypass the 7-layer persist pipeline — write embedding/role/enrichedContext
        // directly to existing graph nodes via graphDB.mergeNodeAttributes()
        log('[WaveController] Direct graph write: merging operator-enriched fields', 'info', {
          entitiesWithEmbedding: embCount, entitiesWithRole: roleCount, entitiesWithContext: ctxCount,
        });
        let directWriteSuccess = 0;
        let directWriteFail = 0;
        for (const entity of currentEntities) {
          const enrichedAttrs: Record<string, any> = {};
          if (entity.embedding && entity.embedding.length > 0) enrichedAttrs.embedding = entity.embedding;
          if (entity.role) enrichedAttrs.role = entity.role;
          if (entity.enrichedContext) enrichedAttrs.enrichedContext = entity.enrichedContext;

          if (Object.keys(enrichedAttrs).length > 0) {
            try {
              // Write directly to graph node — no pipeline, no transformation
              const nodeId = `${this.team}:${entity.name}`;
              // === Phase 42 D-52b — bypass write (Phase 10 fix) ===
              // The km-core adapter is now the unconditional backend
              // (Phase 42 Plan 07 Phase B1). km-core's GraphKMStore.mergeAttributes
              // delegates to Graphology's mergeNodeAttributes, sidestepping
              // the 7-layer pipeline that swallowed the embedding write.
              if (!this.kmCoreAdapter) {
                throw new Error('kmCoreAdapter not bootstrapped — initialize() should have thrown');
              }
              await this.kmCoreAdapter.mergeAttributes(nodeId, enrichedAttrs);
              directWriteSuccess++;
            } catch (e) {
              directWriteFail++;
              // Node might not exist yet — will be created by re-persist below
              log('[WaveController] Direct graph write failed for entity (will try via persist)', 'debug', {
                entity: entity.name, error: e instanceof Error ? e.message : String(e),
              });
            }
          }
        }
        log('[WaveController] Direct graph write complete', 'info', {
          success: directWriteSuccess, failed: directWriteFail,
        });

        // Re-persist refined entities back to the KG (ensures new entities are created)
        log('[WaveController] Re-persisting operator-refined entities via pipeline', 'info', { count: currentEntities.length });
        try {
          const refinedWaveResult: WaveResult = {
            wave: 3,
            agentOutputs: [{
              entities: currentEntities,
              relationships: currentRelations,
              childManifest: [],
              discovered: false,
              durationMs: Date.now() - startTime,
              parentId: '',
              agentName: 'KGOperators',
            }],
            totalEntities: currentEntities.length,
            manifestEntities: currentEntities.filter(e => !e.id?.startsWith('discovered:')).length,
            discoveredEntities: currentEntities.filter(e => e.id?.startsWith('discovered:')).length,
            durationMs: Date.now() - startTime,
            success: true,
          };
          await this.persistWaveResult(refinedWaveResult);
          log('[WaveController] Operator-refined entities persisted via pipeline', 'info');
        } catch (e) { log('[WaveController] Re-persist after operators failed (non-fatal)', 'warning', { error: e instanceof Error ? e.message : String(e) }); }
        } // end of !mockOperators else block

      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log('[WaveController] KG Operators phase failed (non-fatal)', 'warning', { error: errMsg });
      }

      // Signal wave 3 completion to state machine (after KG operators)
      dispatch(buildStepComplete('wave3', 'wave4', 3, startTime));

      // ---- Wave 4: Insight Finalization ----
      if (getState().status === 'cancelled') {
        process.stderr.write('[WaveController] Workflow cancelled, stopping execution\n');
        return this.buildSummaryReport(startTime, waveResults);
      }
      this.logWaveBanner('FINALIZATION', 'Insight Document Generation');
      await this.checkSingleStepPause('wave4_insights', false);
      dispatch({ type: 'substep-update', substepId: 'wave4_insights', wave: 4, totalWaves: 4 });

      const insightResult = await this.generateInsightsForWaveEntities(waveResults);
      log('[WaveController] Insight finalization complete', 'info', {
        generated: insightResult.generated,
        failed: insightResult.failed,
        skippedDiagrams: insightResult.skippedDiagrams,
      });
      this.captureStepMetrics('wave4_insights', {
        generated: insightResult.generated,
        failed: insightResult.failed,
        skippedDiagrams: insightResult.skippedDiagrams,
      });

      // Wave 4 finalize — no pause, just summary report generation

      // Build and return final summary
      const summary = this.buildSummaryReport(startTime, waveResults);

      // Log structured summary
      this.logSummaryReport(summary);

      // Signal wave 4 completion to state machine
      dispatch(buildStepComplete('wave4', 'done', 4, startTime));

      // Final substep-update to mark insights as the last active substep
      dispatch({ type: 'substep-update', substepId: 'wave4_insights_done', wave: 4, totalWaves: 4 });

      // Record all 17 sub-steps from stepsDetail for rich history trace
      try {
        const progressContent = fs.readFileSync(this.progressFile, 'utf-8');
        const progressData = JSON.parse(progressContent);
        const stepsDetail = progressData.stepsDetail || [];
        for (const step of stepsDetail) {
          const stepStart = step.startTime ? new Date(step.startTime) : new Date(startTime);
          const stepEnd = step.endTime ? new Date(step.endTime) : new Date();
          const duration = stepEnd.getTime() - stepStart.getTime();
          const captured = this.stepMetrics.get(step.name);
          this.reportAgent.recordStep({
            stepName: step.name,
            agent: step.name.replace(/^wave\d_/, '').replace(/^operator_/, 'kg_operators:'),
            action: step.name.replace(/_/g, ' '),
            startTime: stepStart,
            endTime: stepEnd,
            duration,
            status: step.status === 'completed' ? 'success' : step.status === 'failed' ? 'failed' : 'skipped',
            inputs: captured?.outputs || {},
            outputs: captured?.outputs || {},
            decisions: [],
            warnings: [],
            errors: [],
            tokensUsed: captured?.tokensUsed || step.tokensUsed,
            llmCalls: captured?.llmCalls || step.llmCalls,
            llmProvider: captured?.llmProvider || step.llmProvider,
          });
        }
      } catch (e) {
        // Fallback: record wave-level steps if progress file can't be read
        for (const wr of waveResults) {
          this.reportAgent.recordStep({
            stepName: `wave${wr.wave}`,
            agent: `wave${wr.wave}`,
            action: `Wave ${wr.wave} analysis`,
            startTime: new Date(startTime),
            endTime: new Date(startTime + wr.durationMs),
            duration: wr.durationMs,
            status: wr.success ? 'success' : 'failed',
            inputs: { manifestEntities: wr.manifestEntities },
            outputs: { totalEntities: wr.totalEntities, discoveredEntities: wr.discoveredEntities },
            decisions: [],
            warnings: [],
            errors: wr.error ? [wr.error] : [],
          });
        }
      }

      // Finalize and save workflow report for history
      try {
        const completedSteps = waveResults.filter(w => w.success).length;
        this.reportAgent.finalizeReport(
          summary.success ? 'completed' : 'failed',
          {
            stepsCompleted: completedSteps,
            totalSteps: 17,
            entitiesCreated: summary.totalEntities,
            entitiesUpdated: 0,
            filesCreated: [],
            contentChanges: summary.totalEntities > 0,
          },
        );
        log('[WaveController] Workflow report saved to .data/workflow-reports/', 'info');
      } catch (e) {
        log('[WaveController] Failed to save workflow report (non-fatal)', 'warning', {
          error: e instanceof Error ? e.message : String(e),
        });
      }

      // Log CGR run summary for observability
      if (this.cgrCache) {
        const cgrStats = this.cgrCache.getStats();
        const hitRate = cgrStats.queriesMade > 0
          ? Math.round((cgrStats.cacheHits / cgrStats.queriesMade) * 100)
          : 0;
        log(`[WaveController] CGR run summary: ${cgrStats.queriesMade} queries, ${cgrStats.cacheHits} cache hits (${hitRate}%), available=${cgrStats.available}`, 'info');
      }

      return summary;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log('[WaveController] Fatal error during wave execution', 'error', { error: errorMsg });

      return {
        success: false,
        waves: waveResults,
        totalEntities: waveResults.reduce((sum, w) => sum + w.totalEntities, 0),
        totalDurationMs: Date.now() - startTime,
        entitiesByLevel: {},
        manifestEntities: 0,
        discoveredEntities: 0,
        error: errorMsg,
      };
    } finally {
      clearInterval(globalHeartbeat);
    }
  }

  // --------------------------------------------------------------------------
  // Wave Execution Methods
  // --------------------------------------------------------------------------

  private async executeWave1(
    manifest: ComponentManifest,
    existingEntities: KGEntity[],
  ): Promise<WaveResult> {
    const { result } = await this.executeWave1WithMetrics(manifest, existingEntities);
    return result;
  }

  private async executeWave1WithMetrics(
    manifest: ComponentManifest,
    existingEntities: KGEntity[],
  ): Promise<{ result: WaveResult; agent: Wave1ProjectAgent | null }> {
    const waveStart = Date.now();

    try {
      const wave1Agent = new Wave1ProjectAgent(this.repositoryPath, this.team, this.cgrCache, this.cgrBuilder, this.runId);
      const output = await wave1Agent.execute({
        manifest,
        existingEntities,
        repositoryPath: this.repositoryPath,
        docContext: this.formatDocContext(),
        onPhase: async (phase: string) => {
          dispatch({ type: 'substep-update', substepId: phase });
          await this.checkSingleStepPause(phase, true);
        },
      });

      return {
        result: {
          wave: 1,
          agentOutputs: [output],
          totalEntities: output.entities.length,
          manifestEntities: output.entities.filter(e => !e.id.startsWith('discovered:')).length,
          discoveredEntities: output.entities.filter(e => e.id.startsWith('discovered:')).length,
          durationMs: Date.now() - waveStart,
          success: true,
        },
        agent: wave1Agent,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        result: {
          wave: 1,
          agentOutputs: [],
          totalEntities: 0,
          manifestEntities: 0,
          discoveredEntities: 0,
          durationMs: Date.now() - waveStart,
          success: false,
          error: errorMsg,
        },
        agent: null,
      };
    }
  }

  private async executeWave2(
    wave1Result: WaveResult,
    manifest: ComponentManifest,
  ): Promise<WaveResult> {
    const { result } = await this.executeWave2WithMetrics(wave1Result, manifest);
    return result;
  }

  private async executeWave2WithMetrics(
    wave1Result: WaveResult,
    manifest: ComponentManifest,
  ): Promise<{ result: WaveResult; agents: Array<{ getLLMMetrics(): { providers: string[]; totalTokens: number; totalCalls: number } }> }> {
    const waveStart = Date.now();
    const createdAgents: Array<{ getLLMMetrics(): { providers: string[]; totalTokens: number; totalCalls: number } }> = [];

    try {
      // Dynamic import: Wave2ComponentAgent is created by Plan 03 (runs in parallel)
      const { Wave2ComponentAgent } = await import('./wave2-component-agent.js');

      // Gather all L1 entities from Wave 1
      const l1Entities = wave1Result.agentOutputs
        .flatMap(o => o.entities)
        .filter(e => e.level === 1);

      // Gather all child manifest entries from Wave 1
      const allChildManifest = wave1Result.agentOutputs.flatMap(o => o.childManifest);

      // Shared phase lock: only one concurrent entity pauses at a time.
      // Without this, N entities all pause/resume on the same file, causing N×4 sub-step repetitions.
      let phaseLockHolder: string | null = null;

      // Build agent tasks for each L1 entity
      const agentTasks = l1Entities.map(l1Entity => {
        return async (): Promise<WaveAgentOutput> => {
          // Find child manifest entries for this L1 entity
          const childEntries = allChildManifest.filter(
            c => c.parentId === l1Entity.name && c.level === 2,
          );

          // Get component files via code-graph-rag (graceful fallback)
          const componentKeywords = manifest.components
            .find(c => c.name === l1Entity.name)?.keywords ?? [];
          const componentFiles = await this.getComponentFiles(l1Entity.name, componentKeywords);

          const wave2Input: Wave2Input = {
            l1Entity,
            componentFiles,
            componentKeywords,
            manifestChildren: childEntries,
            docContext: this.formatDocContext(),
            onPhase: async (phase: string) => {
              // Only one entity pauses per phase — others skip to avoid N×duplicate pauses
              if (phaseLockHolder === null || phaseLockHolder === l1Entity.name) {
                phaseLockHolder = l1Entity.name;
                dispatch({ type: 'substep-update', substepId: phase });
                await this.checkSingleStepPause(phase, true);
                phaseLockHolder = null; // Release after resume
              }
            },
          };

          const agent = new Wave2ComponentAgent(this.repositoryPath, this.team, this.cgrCache, this.cgrBuilder, this.runId);
          createdAgents.push(agent);
          return agent.execute(wave2Input);
        };
      });

      // Run agents with bounded concurrency, flushing progress after each completes
      let w2CompletedCount = 0;
      this.resetItemProgressThrottle();
      const outputs = await this.runWithConcurrency(agentTasks, this.maxAgentsPerWave, (idx, output) => {
        w2CompletedCount++;
        this.maybeEmitItemProgress('wave2_analyze', w2CompletedCount, agentTasks.length);
        // Capture agent instance incrementally
        const agent = createdAgents[idx] as WaveAgentWithMetrics | undefined;
        this.captureAgentInstance('wave2_analyze', {
          agentId: `wave2_agent_${output.parentId || output.agentName}`,
          agentType: 'Wave2ComponentAgent',
          parentEntity: output.parentId || output.agentName,
          startTime: new Date(waveStart).toISOString(),
          endTime: new Date().toISOString(),
          status: 'completed',
          llmCalls: agent ? this.convertLLMMetricsToCalls(agent.getDetailedCalls()) : [],
          entityCount: output.entities.length,
          observationCount: output.entities.reduce((sum: number, e: KGEntity) => sum + (e.observations?.length || 0), 0),
        });
        // Flush progress so dashboard sees each agent complete
        dispatch({ type: 'substep-update', substepId: 'wave2_analyze', wave: 2, totalWaves: 4 });
      });

      const totalEntities = outputs.reduce((sum, o) => sum + o.entities.length, 0);
      const manifestCount = outputs.reduce(
        (sum, o) => sum + o.entities.filter(e => !e.id.startsWith('discovered:')).length, 0,
      );
      const discoveredCount = outputs.reduce(
        (sum, o) => sum + o.entities.filter(e => e.id.startsWith('discovered:')).length, 0,
      );

      return {
        result: {
          wave: 2,
          agentOutputs: outputs,
          totalEntities,
          manifestEntities: manifestCount,
          discoveredEntities: discoveredCount,
          durationMs: Date.now() - waveStart,
          success: true,
        },
        agents: createdAgents,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        result: {
          wave: 2,
          agentOutputs: [],
          totalEntities: 0,
          manifestEntities: 0,
          discoveredEntities: 0,
          durationMs: Date.now() - waveStart,
          success: false,
          error: errorMsg,
        },
        agents: createdAgents,
      };
    }
  }

  private async executeWave3(wave2Result: WaveResult, manifest: ComponentManifest): Promise<WaveResult> {
    const { result } = await this.executeWave3WithMetrics(wave2Result, manifest);
    return result;
  }

  private async executeWave3WithMetrics(
    wave2Result: WaveResult,
    manifest: ComponentManifest,
  ): Promise<{ result: WaveResult; agents: Array<{ getLLMMetrics(): { providers: string[]; totalTokens: number; totalCalls: number } }> }> {
    const waveStart = Date.now();
    const createdAgents: Array<{ getLLMMetrics(): { providers: string[]; totalTokens: number; totalCalls: number } }> = [];

    try {
      // Dynamic import: Wave3DetailAgent is created by Plan 03 (runs in parallel)
      const { Wave3DetailAgent } = await import('./wave3-detail-agent.js');

      // Gather all L2 entities from Wave 2 (both manifest-defined and discovered)
      const l2Entities = wave2Result.agentOutputs
        .flatMap(o => o.entities)
        .filter(e => e.level === 2);

      // Collect all L3 suggestions from Wave 2 agent outputs, with a global cap
      const allL3Suggestions = wave2Result.agentOutputs.flatMap(o => o.childManifest);
      const MAX_TOTAL_L3_AGENTS = 50;
      if (allL3Suggestions.length > MAX_TOTAL_L3_AGENTS) {
        log(`[WaveController] Capping total L3 agent tasks: ${allL3Suggestions.length} -> ${MAX_TOTAL_L3_AGENTS}`, 'warning');
        allL3Suggestions.length = MAX_TOTAL_L3_AGENTS;
      }
      log(`[WaveController] Wave 3 will process ${l2Entities.length} L2 entities with ${allL3Suggestions.length} L3 suggestions`, 'info');

      // Gather all L1 entities for hierarchy path construction
      // L1 entities are the parents referenced by L2 entity parentId
      const l1EntityMap = new Map<string, KGEntity>();
      for (const output of wave2Result.agentOutputs) {
        for (const entity of output.entities) {
          if (entity.level === 1) {
            l1EntityMap.set(entity.name, entity);
          }
        }
      }

      // Shared phase lock: only one concurrent entity pauses at a time (same as Wave 2)
      let phaseLockHolder: string | null = null;

      // Build agent tasks for each L2 entity
      const agentTasks = l2Entities.map(l2Entity => {
        return async (): Promise<WaveAgentOutput> => {
          // Find the parent L1 entity
          const parentId = l2Entity.parentId ?? '';
          const l1Entity = l1EntityMap.get(parentId);

          // ENHANCED: Use L1 keywords for broader file scoping (not just L2 name)
          const l1Component = manifest.components.find(c => c.name === parentId);
          const l1Keywords = l1Component?.keywords ?? [];
          const scopedFiles = await this.getComponentFiles(
            l2Entity.name,
            [l2Entity.name.toLowerCase(), ...l1Keywords],
          );

          // Pass suggested L3 children from Wave 2 for this L2 entity
          const suggestedChildren = allL3Suggestions.filter(
            c => c.parentId === l2Entity.name && c.level === 3,
          );

          const wave3Input: Wave3Input = {
            l2Entity,
            l1Entity: l1Entity ?? {
              id: parentId,
              name: parentId,
              type: 'Component',
              observations: [],
              significance: 8,
              level: 1,
            },
            scopedFiles,
            suggestedChildren,
            docContext: this.formatDocContext(),
            onPhase: async (phase: string) => {
              // Only one entity pauses per phase — others skip to avoid N×duplicate pauses
              if (phaseLockHolder === null || phaseLockHolder === l2Entity.name) {
                phaseLockHolder = l2Entity.name;
                dispatch({ type: 'substep-update', substepId: phase });
                await this.checkSingleStepPause(phase, true);
                phaseLockHolder = null;
              }
            },
          };

          const agent = new Wave3DetailAgent(this.repositoryPath, this.team, this.cgrCache, this.cgrBuilder, this.runId);
          createdAgents.push(agent);
          return agent.execute(wave3Input);
        };
      });

      // Run agents with bounded concurrency, flushing progress after each completes
      let w3CompletedCount = 0;
      this.resetItemProgressThrottle();
      const outputs = await this.runWithConcurrency(agentTasks, this.maxAgentsPerWave, (idx, output) => {
        w3CompletedCount++;
        this.maybeEmitItemProgress('wave3_analyze', w3CompletedCount, agentTasks.length);
        // Capture agent instance incrementally
        const agent = createdAgents[idx] as WaveAgentWithMetrics | undefined;
        this.captureAgentInstance('wave3_analyze', {
          agentId: `wave3_agent_${output.parentId || output.agentName}`,
          agentType: 'Wave3DetailAgent',
          parentEntity: output.parentId || output.agentName,
          startTime: new Date(waveStart).toISOString(),
          endTime: new Date().toISOString(),
          status: 'completed',
          llmCalls: agent ? this.convertLLMMetricsToCalls(agent.getDetailedCalls()) : [],
          entityCount: output.entities.length,
          observationCount: output.entities.reduce((sum: number, e: KGEntity) => sum + (e.observations?.length || 0), 0),
        });
        // Flush progress so dashboard sees each agent complete
        dispatch({ type: 'substep-update', substepId: 'wave3_analyze', wave: 3, totalWaves: 4 });
      });

      const totalEntities = outputs.reduce((sum, o) => sum + o.entities.length, 0);

      return {
        result: {
          wave: 3,
          agentOutputs: outputs,
          totalEntities,
          manifestEntities: 0, // Wave 3 is pure discovery
          discoveredEntities: totalEntities,
          durationMs: Date.now() - waveStart,
          success: true,
        },
        agents: createdAgents,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        result: {
          wave: 3,
          agentOutputs: [],
          totalEntities: 0,
          manifestEntities: 0,
          discoveredEntities: 0,
          durationMs: Date.now() - waveStart,
          success: false,
          error: errorMsg,
        },
        agents: createdAgents,
      };
    }
  }

  // --------------------------------------------------------------------------
  // QA Retry-with-Feedback
  // --------------------------------------------------------------------------

  /**
   * Build a feedback string from QA errors for logging and future prompt injection.
   */
  private buildQAFeedbackContext(qaErrors: string[]): string {
    return [
      '## QA Feedback (retry attempt)',
      'The previous output was rejected by quality assurance. Fix these issues:',
      ...qaErrors.map(e => `- ${e}`),
      '',
      'Ensure all entities have at least 3 specific observations with code references.',
    ].join('\n');
  }

  /**
   * Retry a wave execution when QA rejects output (score < 60).
   * Capped at 1 retry per wave -- if retry also fails, returns whichever scored higher.
   */
  private async retryWaveWithFeedback(
    waveNumber: number,
    qaErrors: string[],
    originalEntities: KGEntity[],
    retryFn: () => Promise<WaveResult>,
  ): Promise<{ result: WaveResult; retried: boolean }> {
    const feedbackContext = this.buildQAFeedbackContext(qaErrors);

    log('[WaveController] QA rejected wave output, retrying with feedback', 'info', {
      wave: waveNumber,
      errors: qaErrors.length,
      feedback: feedbackContext,
    });

    try {
      const retryResult = await retryFn();
      return { result: retryResult, retried: true };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log('[WaveController] QA retry failed with error, keeping original output', 'warning', {
        wave: waveNumber,
        error: errMsg,
      });
      // Return a synthetic result wrapping original entities so caller can proceed
      return {
        result: {
          wave: waveNumber,
          agentOutputs: [{
            entities: originalEntities,
            relationships: [],
            childManifest: [],
            discovered: false,
            durationMs: 0,
            parentId: '',
            agentName: `wave${waveNumber}_retry_fallback`,
          }],
          totalEntities: originalEntities.length,
          manifestEntities: originalEntities.length,
          discoveredEntities: 0,
          durationMs: 0,
          success: true,
        },
        retried: false,
      };
    }
  }

  // --------------------------------------------------------------------------
  // Content Quality Validation
  // --------------------------------------------------------------------------

  /**
   * Check whether a single observation is generic/vague.
   * Generic = short, no code artifact references, matches vague phrases.
   */
  private isGenericObservation(obs: string): boolean {
    // Too short to be meaningful
    if (obs.length < 50) return true;

    // Check for code artifact references (file paths, class/function names)
    const hasCodeRef = /[a-zA-Z_]\w*\.\w+|\/[\w/.-]+\.\w{1,5}|[A-Z][a-z]+[A-Z]\w+|\w+\(\)/.test(obs);
    if (hasCodeRef) return false;

    // Generic vague phrases
    const genericPatterns = [
      /works?\s+well/i,
      /important\s+(feature|component|part)/i,
      /key\s+(component|feature|part|element)/i,
      /provides?\s+(functionality|features?)/i,
      /handles?\s+(various|different|multiple)/i,
      /is\s+(a|an|the)\s+(main|core|key|important)/i,
      /used\s+(for|to)\s+(manage|handle|process)/i,
      /responsible\s+for/i,
    ];
    return genericPatterns.some(p => p.test(obs));
  }

  /**
   * Unified constraint validation gate for entities before persistence.
   * Runs four rule categories, collecting ALL failure reasons (no short-circuit).
   *
   * Rule 1: Entity naming (PascalCase, not generic, valid length)
   * Rule 2: Observation count (>= 3 required)
   * Rule 3: Content quality (multi-sentence, not all generic, code-grounded)
   * Rule 4: Hierarchy integrity (valid level, parent exists, path depth)
   */
  private validateEntityForPersistence(
    entity: SharedMemoryEntity,
    allEntityNames: Set<string>,
  ): { valid: boolean; reasons: string[] } {
    const reasons: string[] = [];

    // ---- Rule 1: Entity naming ----
    if (!PASCAL_CASE_REGEX.test(entity.name)) {
      reasons.push(`Name '${entity.name}' is not PascalCase`);
    }
    if (GENERIC_ENTITY_NAMES.has(entity.name)) {
      reasons.push(`Name '${entity.name}' is generic/blocklisted`);
    }
    if (entity.name.length < 3 || entity.name.length > 80) {
      reasons.push(`Name '${entity.name}' invalid length (${entity.name.length})`);
    }

    // ---- Rule 2: Observation count ----
    const observations = entity.observations || [];
    const obsStrings = observations.map(obs => typeof obs === 'string' ? obs : obs.content);
    if (obsStrings.length < 3) {
      reasons.push(`Insufficient observations (${obsStrings.length}/3 required)`);
    }

    // ---- Rule 3: Content quality ----
    if (obsStrings.length > 0) {
      // At least one observation must be multi-sentence (2+ periods or semicolons)
      const hasMultiSentence = obsStrings.some(obs => {
        const sentenceEnders = (obs.match(/[.;]/g) || []).length;
        return sentenceEnders >= 2;
      });
      if (!hasMultiSentence) {
        reasons.push('All observations are single-sentence stubs');
      }

      // Not all observations generic
      const genericCount = obsStrings.filter(obs => this.isGenericObservation(obs)).length;
      if (genericCount === obsStrings.length) {
        reasons.push('All observations are generic');
      }

      // At least one observation should reference code
      const codeRefPattern = /\/[\w/.-]+\.\w{1,5}|\.\w{2,4}\b|[A-Z][a-z]+[A-Z]\w+/;
      const hasCodeRef = obsStrings.some(obs => codeRefPattern.test(obs));
      if (!hasCodeRef) {
        reasons.push('No code-grounded observations');
      }
    }

    // ---- Rule 4: Hierarchy integrity ----
    const level = entity.hierarchyLevel;
    if (level === undefined || level === null || level < 0 || level > 3) {
      reasons.push(`Invalid hierarchy level (${level})`);
    } else {
      // L0 entities should NOT have parentEntityName
      if (level === 0 && entity.parentEntityName) {
        reasons.push(`L0 entity should not have parentEntityName ('${entity.parentEntityName}')`);
      }
      // If parentEntityName is set (non-L0), it must exist in current wave OR prior waves
      if (level > 0 && entity.parentEntityName && !allEntityNames.has(entity.parentEntityName) && !this.persistedEntityNames.has(entity.parentEntityName)) {
        reasons.push(`Parent '${entity.parentEntityName}' not found in entity set or prior waves`);
      }
    }
    // HierarchyPath depth should match level (field may exist on extended entity objects)
    const hierarchyPath = (entity as any).hierarchyPath as string | undefined;
    if (hierarchyPath) {
      const pathDepth = hierarchyPath.split('/').filter(Boolean).length;
      if (level !== undefined && level !== null && pathDepth !== level + 1) {
        reasons.push(`HierarchyPath depth mismatch (path depth ${pathDepth}, expected ${level + 1})`);
      }
    }

    return { valid: reasons.length === 0, reasons };
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  private async persistWaveResult(waveResult: WaveResult): Promise<void> {
    // Collect all entities from all agents in this wave
    const allEntities = waveResult.agentOutputs.flatMap(o => o.entities);
    const allRelationships = waveResult.agentOutputs.flatMap(o => o.relationships);

    // Convert KGEntity to SharedMemoryEntity format for the constraint gate
    // (the canonical km-core write below also consumes this shape).
    const sharedMemoryEntities = allEntities.map(e => this.mapEntityToSharedMemory(e));

    // Unified constraint validation gate
    const allEntityNames = new Set(sharedMemoryEntities.map(e => e.name));
    const qualityFilteredEntities = sharedMemoryEntities.filter(e => {
      const result = this.validateEntityForPersistence(e, allEntityNames);
      if (!result.valid) {
        log(`[WaveController] Constraint rejection: ${e.name} - ${result.reasons.join('; ')}`, 'warning');
        return false;
      }
      return true;
    });
    log(`[WaveController] Constraint gate: ${qualityFilteredEntities.length}/${sharedMemoryEntities.length} entities passed`, 'info');

    // Track persisted entity names for cross-wave parent validation
    const persistedNames = new Set(qualityFilteredEntities.map(e => e.name));
    for (const name of persistedNames) {
      this.persistedEntityNames.add(name);
    }

    // Phase 42 Plan 07 Phase B1 — km-core is the only persistence path.
    // The KM_CORE_PERSISTENCE feature flag and the legacy 7-layer
    // persistence-agent.persistEntities branch have been removed. Per-entity /
    // per-relation errors are fail-soft (Phase 41 resolveEntities precedent —
    // T-42-06-03). initialize() guarantees this.kmCoreAdapter is bootstrapped.
    if (!this.kmCoreAdapter) {
      throw new Error('persistWaveResult: kmCoreAdapter not bootstrapped — initialize() should have thrown');
    }
    const result = await this.persistWithKmCore(
      qualityFilteredEntities,
      allRelationships,
      this.runId,
    );
    log(`[WaveController] km-core persistence complete (wave ${waveResult.wave})`, 'info', {
      entitiesStored: result.entitiesStored,
      entityErrors: result.entityErrors,
      relationshipsStored: result.relationshipsStored,
      relationshipErrors: result.relationshipErrors,
      relationshipsSkipped: result.relationshipsSkipped,
      anchorEdgesAdded: result.anchorEdgesAdded,
      anchorEdgesFailed: result.anchorEdgesFailed,
      anchorEdgesSkipped: result.anchorEdgesSkipped,
    });

    log(`[WaveController] Wave ${waveResult.wave} persistence complete`, 'info', {
      entities: allEntities.length,
      relationships: allRelationships.length,
    });
  }

  /**
   * Phase 42.1 INT-02 — find the best parent Component/SubComponent for an entity.
   *
   * Ported (Phase 42.1 — INT-02 anchor parity) from the legacy persistence
   * agent (lines 1043-1071 of the retired module). DO NOT delete this method —
   * the post-sweep anchor pass in `persistWithKmCore` relies on it.
   *
   * Algorithm (mirror of the legacy implementation at lines 1043-1071):
   *   1. Filter to candidates whose entityType is Component or SubComponent.
   *   2. Lowercase the target name; walk candidates.
   *   3. If the target name (lowercased) contains the candidate name (lowercased) AND the
   *      candidate name is longer than the current best match, prefer the candidate.
   *      Ties broken toward SubComponent over Component (more specific).
   *   4. Return the best match's name; otherwise fall back to 'Coding' (Project) if present.
   *   5. Return null if no match AND no Coding project — caller decides to skip.
   */
  private findBestParent(entityName: string, allEntities: SharedMemoryEntity[]): string | null {
    const candidates = allEntities.filter(
      (e) =>
        (e.entityType === 'SubComponent' || e.entityType === 'Component') &&
        // NEVER consider the entity itself. Every string contains itself, and
        // self is by definition the longest self-match, so without this an
        // entity that IS a Component/SubComponent always resolved to itself:
        // the caller then refused the self-edge and counted a skip, and the
        // truthy `bestMatch` short-circuited the 'Coding' fallback below. Net
        // effect — the anchor pass could not repair a Component or
        // SubComponent at all, only a Detail. That is why 4 SubComponents were
        // still orphaned after the 2026-09-08 run.
        e.name !== entityName,
    );

    const lowerName = entityName.toLowerCase();
    let bestMatch: SharedMemoryEntity | null = null;
    let bestLen = 0;

    for (const c of candidates) {
      const cLower = c.name.toLowerCase();
      // Entity name contains the component/sub-component name
      if (lowerName.includes(cLower) && cLower.length > bestLen) {
        // Prefer SubComponent over Component (more specific)
        if (!bestMatch || c.entityType === 'SubComponent' || cLower.length > bestLen) {
          bestMatch = c;
          bestLen = cLower.length;
        }
      }
    }

    // If a specific parent was found, use it. Otherwise fall back to "Coding" root.
    if (bestMatch) return bestMatch.name;

    // Check if 'Coding' project exists in allEntities
    const codingProject = allEntities.find(
      (e) => e.name === 'Coding' && e.entityType === 'Project',
    );
    return codingProject ? 'Coding' : null;
  }

  /**
   * Phase 42.1 INT-02 — idempotent bootstrap of the Coding (Project) anchor.
   *
   * Queries km-core for an existing Project entity named 'Coding'. If present,
   * returns early (idempotent re-run). If absent, mints a minimal Project entity
   * via `kmCoreAdapter.storeEntity(...)` so the subsequent anchor pass has a
   * valid fallback target for entities with no Component/SubComponent match.
   *
   * Failure is fail-soft: a thrown `storeEntity` increments a local counter
   * and writes one stderr line; the next ukb full will retry the bootstrap.
   *
   * Caller: `persistWithKmCore` invokes this BEFORE the anchor-pass loop so
   * the loop can rely on `findBestParent` returning 'Coding' as a fallback.
   *
   * Mirrors `_ensureProjectAnchor` from src/live-logging/ObservationConsolidator.js
   * (the online-path equivalent) — same semantics, different storage adapter.
   */
  private async ensureProjectAnchor(runId: string): Promise<void> {
    if (!this.kmCoreAdapter) {
      // Guarded upstream by persistWithKmCore; this is defensive.
      throw new Error('ensureProjectAnchor called without kmCoreAdapter bootstrapped');
    }
    try {
      const existing = await this.kmCoreAdapter.queryEntities({ entityType: 'Project' });
      if (existing.some((e) => e.name === 'Coding')) {
        // Already present — idempotent re-run. Still seed the name: the
        // relationship sweep drops edges whose endpoints it cannot find in
        // persistedEntityNames, and returning without seeding made every
        // `Coding -> Component` edge depend on the init-time seed having
        // loaded the Project.
        this.persistedEntityNames.add('Coding');
        return;
      }
      await this.kmCoreAdapter.storeEntity(
        {
          name: 'Coding',
          entityType: 'Project',
          ontologyClass: 'Project',
          observations: ['Coding project root entity (anchor for wave-analysis emissions).'],
          significance: 10,
          metadata: {
            subsystem: 'wave-analysis',
            source: 'wave-analysis',
            runId,
          },
        },
        { team: this.team },
      );
      // Track in the local persistedEntityNames set so the relation sweep
      // (and any future caller within the same wave) does not skip Coding-targeted
      // edges as "unknown target".
      this.persistedEntityNames.add('Coding');
      log(
        `[WaveController] Coding Project anchor minted (cold-start) for runId=${runId}`,
        'info',
      );
    } catch (err) {
      process.stderr.write(
        `[WaveController] ensureProjectAnchor failed (runId=${runId}): ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      // Fail-soft: the anchor pass that follows will safely no-op for entities
      // whose findBestParent returns null.
    }
  }

  /**
   * Phase 42 Plan 06+07 — unconditional km-core write path.
   *
   * Iterates the wave-constraint-filtered entities + relationships and routes
   * each through the Plan 01 km-core adapter:
   *   - `kmCoreAdapter.storeEntity(entity, { team })` for entity writes.
   *   - `kmCoreAdapter.storeRelationship(from, to, type, metadata)` for edges.
   *
   * Both calls are wrapped in try/catch so a single failed entity does not
   * abort the wave's persistence sweep (matches Phase 41 resolveEntities
   * resilience precedent; T-42-06-03 threat-model mitigation).
   *
   * Returns counters for the summary log. The legacy 7-layer pipeline
   * (persistence-agent.persistEntities) has been removed from the wave
   * controller in Plan 07 Phase B1 (D-52b). persistence-agent.ts itself
   * is deferred to a follow-up phase per the architectural-surprise
   * cascade (see 42-07-SUMMARY.md).
   */
  private async persistWithKmCore(
    entities: SharedMemoryEntity[],
    relationships: KGRelation[],
    runId: string,
  ): Promise<{
    entitiesStored: number;
    entityErrors: number;
    relationshipsStored: number;
    relationshipErrors: number;
    relationshipsSkipped: number;
    anchorEdgesAdded: number;
    anchorEdgesFailed: number;
    anchorEdgesSkipped: number;
  }> {
    if (!this.kmCoreAdapter) {
      throw new Error('persistWithKmCore called without kmCoreAdapter bootstrapped');
    }

    let entitiesStored = 0;
    let entityErrors = 0;
    let relationshipsStored = 0;
    let relationshipErrors = 0;
    let relationshipsSkipped = 0;
    // Phase 42.1 INT-02 — anchor-pass counters (wired into the post-sweep block by Task 4).
    let anchorEdgesAdded = 0;
    let anchorEdgesFailed = 0;
    let anchorEdgesSkipped = 0;

    // ---- Entity sweep ----
    for (const e of entities) {
      try {
        await this.kmCoreAdapter.storeEntity(
          {
            name: e.name,
            entityType: e.entityType,
            // canonical fields stamped by wave1/wave2/wave3 emit (Plan 06 Task 1)
            ontologyClass: (e as { ontologyClass?: unknown }).ontologyClass,
            legacyId: (e as { legacyId?: unknown }).legacyId,
            observations: e.observations.map((obs) =>
              typeof obs === 'string' ? obs : obs.content,
            ),
            significance: e.significance,
            metadata: e.metadata,
            parentId: e.parentEntityName,
            level: e.hierarchyLevel,
            // Operator-enriched fields ride along for the adapter's metadata mapping
            ...((e as { embedding?: unknown }).embedding
              ? { embedding: (e as { embedding?: unknown }).embedding }
              : {}),
            ...((e as { role?: unknown }).role
              ? { role: (e as { role?: unknown }).role }
              : {}),
            ...((e as { enrichedContext?: unknown }).enrichedContext
              ? { enrichedContext: (e as { enrichedContext?: unknown }).enrichedContext }
              : {}),
          },
          { team: this.team },
        );
        entitiesStored += 1;
      } catch (err) {
        entityErrors += 1;
        process.stderr.write(
          `[WaveController] km-core storeEntity failed for ${e.name} (runId=${runId}): ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }

    // The Coding Project anchor must exist BEFORE the relationship sweep, not
    // after it: the sweep drops any edge whose endpoints are not in
    // persistedEntityNames, so on a cold start every `Coding -> Component`
    // contains edge was skipped and then the anchor pass — which used to mint
    // the anchor — reported them as already handled.
    await this.ensureProjectAnchor(runId);

    // ---- Relationship sweep ----
    // Targets whose contains/parent-child edge ACTUALLY landed. The anchor
    // pass keys off this rather than off `relationships`, because an intended
    // edge is not an edge: a relation whose parent failed the constraint gate
    // is skipped here, and marking its target "anchored" is what disarmed the
    // repair pass that exists precisely for this case.
    const anchoredByStoredEdge = new Set<string>();
    for (const rel of relationships) {
      if (!this.persistedEntityNames.has(rel.from) || !this.persistedEntityNames.has(rel.to)) {
        relationshipsSkipped += 1;
        if (rel.type === 'contains' || rel.type === 'parent-child') {
          // Leave a trace: this is the edge the anchor pass will have to
          // synthesize, and its absence used to be silent.
          log(
            `[WaveController] relation skipped, endpoint not persisted: ${rel.from} -> ${rel.to} (${rel.type})`,
            'debug',
          );
        }
        continue;
      }
      try {
        await this.kmCoreAdapter.storeRelationship(
          rel.from,
          rel.to,
          rel.type,
          { weight: rel.weight, source: rel.source, batchId: rel.batchId, runId },
        );
        relationshipsStored += 1;
        if (rel.type === 'contains' || rel.type === 'parent-child') {
          anchoredByStoredEdge.add(rel.to);
        }
      } catch (err) {
        relationshipErrors += 1;
        process.stderr.write(
          `[WaveController] km-core storeRelationship failed for ${rel.from} -> ${rel.to} (${rel.type}, runId=${runId}): ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }

    // ---- Anchor pass (Phase 42.1 INT-02) ----
    // Ported (Phase 42.1 INT-02) from the legacy persistence agent's
    // updateEntityRelationships post-sweep.
    // Restores the contains-edge insertion the legacy persistence path performed
    // after every batch; without this, wave-emitted entities arrive without any
    // incoming contains/parent-child edge from a Component/SubComponent or the
    // Coding Project root (forensic report 2026-05-24).
    //
    // Runs LAST so it can read the just-stored entities AND the just-stored
    // relations. Two-layer idempotency check:
    //   (a) in-wave Set of edges just stored (rel.to via 'contains'/'parent-child')
    //   (b) km-core store query for existing incoming edges (second-run case)
    // Layer (c) — km-core's addRelation is upsert-by-(from,to,type) — gives a
    // third defense at the storage layer.
    // ensureProjectAnchor now runs before the relationship sweep (see above).

    // Layer (a) — in-wave edges that were actually STORED. This used to walk
    // `relationships` and mark every intended target, so an entity whose edge
    // had just been skipped was treated as anchored and never repaired: the
    // pass reported `added=0 skipped=N failed=0` for every batch of the
    // 2026-09-07 runs while the entities it skipped had no incoming edge at
    // all.
    const alreadyAnchored = new Set<string>(anchoredByStoredEdge);

    // Layer (b) — persisted store. Use the adapter's queryIncomingRelations
    // (Phase 42.1 added). On adapter failure, fall through to the storeRelationship
    // try/catch — duplicates are tolerated by km-core's upsert semantics.
    for (const e of entities) {
      if (alreadyAnchored.has(e.name)) continue;
      try {
        const inRels = await this.kmCoreAdapter.queryIncomingRelations(e.name);
        if (inRels.some((r) => r.type === 'contains' || r.type === 'parent-child')) {
          alreadyAnchored.add(e.name);
        }
      } catch {
        // Adapter doesn't support the query OR it threw — fall through; the
        // storeRelationship try/catch below absorbs duplicates.
      }
    }

    // Walk the entities and insert a contains edge for every entity that needs one.
    for (const e of entities) {
      if (e.entityType === 'Project' || e.entityType === 'System') {
        // These ARE the anchors / scaffolding; do NOT add incoming contains edges.
        continue;
      }
      if (alreadyAnchored.has(e.name)) {
        anchorEdgesSkipped += 1;
        continue;
      }
      const parent = this.findBestParent(e.name, entities);
      if (!parent) {
        anchorEdgesSkipped += 1;
        process.stderr.write(
          `[WaveController] anchor pass: no parent found for ${e.name} (runId=${runId})\n`,
        );
        continue;
      }
      if (parent === e.name) {
        // Pathological — self-named root. Guard defensively.
        anchorEdgesSkipped += 1;
        process.stderr.write(
          `[WaveController] anchor pass: refusing self-edge for ${e.name} (runId=${runId})\n`,
        );
        continue;
      }
      try {
        await this.kmCoreAdapter.storeRelationship(
          parent,
          e.name,
          'contains',
          { source: 'wave-analysis', runId },
        );
        anchorEdgesAdded += 1;
      } catch (err) {
        anchorEdgesFailed += 1;
        process.stderr.write(
          `[WaveController] anchor pass: storeRelationship failed for ${parent} -> ${e.name} (contains, runId=${runId}): ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }

    log(
      `[WaveController] Project-anchor pass: added=${anchorEdgesAdded} skipped=${anchorEdgesSkipped} failed=${anchorEdgesFailed}`,
      'info',
    );

    return {
      entitiesStored,
      entityErrors,
      relationshipsStored,
      relationshipErrors,
      relationshipsSkipped,
      anchorEdgesAdded,
      anchorEdgesFailed,
      anchorEdgesSkipped,
    };
  }

  /**
   * Classify a single entity using the OntologyClassificationAgent.
   * Per-entity sequential classification -- each entity gets its own classification call.
   * Mutates entity in-place: updates entity.type and attaches _ontologyMetadata.
   */
  private async classifyEntity(entity: KGEntity): Promise<void> {
    const ontologyAgent = new OntologyClassificationAgent(this.team, this.repositoryPath);
    try {
      const classificationResult = await ontologyAgent.classifyObservations({
        observations: [{
          name: entity.name,
          entityType: entity.type || 'Unclassified',
          observations: entity.observations || [],
          significance: entity.significance || 5,
          tags: [],
        }],
        autoExtend: true,
        minConfidence: 0.6,
      });

      if (classificationResult?.classified?.length > 0) {
        const classification = classificationResult.classified[0];
        if (classification?.classified && classification?.ontologyMetadata) {
          // Do NOT override entity.type — it carries the hierarchy role (Project, Component,
          // SubComponent, Detail) which the VKB graph uses for node coloring/sizing.
          // Store ontology class in metadata only.
          (entity as any)._ontologyMetadata = {
            ontologyClass: classification.ontologyMetadata.ontologyClass,
            ontologyVersion: classification.ontologyMetadata.ontologyVersion || '1.0',
            classificationConfidence: classification.ontologyMetadata.classificationConfidence,
            classificationMethod: classification.ontologyMetadata.classificationMethod,
            ontologySource: classification.ontologyMetadata.ontologySource || 'lower',
            classifiedAt: classification.ontologyMetadata.classifiedAt || new Date().toISOString(),
          };
          // Append ontology trace data
          const traceArr = (entity as any)._traceData || [];
          traceArr.push({
            llmCallCount: 1,
            totalDurationMs: 0, // ontology agent doesn't expose timing yet
            model: 'heuristic+llm',
            provider: 'ontology',
            agentType: 'OntologyClassificationAgent',
          });
          (entity as any)._traceData = traceArr;
        }
      }
    } catch (err) {
      log(`[WaveController] Ontology classification failed for ${entity.name}, using hierarchy fallback: ${err instanceof Error ? err.message : String(err)}`, 'warning');
      // Entity keeps its existing type -- mapEntityToSharedMemory handles fallback
    }
  }

  /**
   * @deprecated Use classifyEntity() per-entity instead.
   *
   * Run ontology classification on wave entities using the real OntologyClassificationAgent.
   * This replaces the naive level-based "auto-assigned" classification with actual
   * semantic classification (heuristic + LLM) against the project ontology.
   *
   * Mutates entities in-place: updates entity.type and attaches ontologyMetadata
   * so that mapEntityToSharedMemory() can use the real classification.
   */
  private async classifyWaveEntities(waveResult: WaveResult): Promise<{
    classified: number;
    unclassified: number;
    byClass: Record<string, number>;
  }> {
    const allEntities = waveResult.agentOutputs.flatMap(o => o.entities);
    if (allEntities.length === 0) {
      return { classified: 0, unclassified: 0, byClass: {} };
    }

    try {
      const ontologyAgent = new OntologyClassificationAgent(this.team, this.repositoryPath);

      // Transform wave entities to the observation format expected by the classification agent
      const observationsForClassification = allEntities.map(entity => ({
        name: entity.name,
        entityType: entity.type || 'Unclassified',
        observations: entity.observations || [],
        significance: entity.significance || 5,
        tags: [] as string[],
      }));

      const classificationResult = await ontologyAgent.classifyObservations({
        observations: observationsForClassification,
        autoExtend: true,
        minConfidence: 0.6,
      });

      if (classificationResult?.classified && classificationResult.classified.length > 0) {
        // Build a name -> classification map for fast lookup
        const classifiedMap = new Map<string, any>(
          classificationResult.classified
            .filter((c: any) => c.classified && c.ontologyMetadata)
            .map((c: any) => [c.original?.name, c]),
        );

        // Apply classifications back to entities in-place
        for (const entity of allEntities) {
          const classification = classifiedMap.get(entity.name);
          if (classification?.ontologyMetadata) {
            // Store ontology metadata on the entity for mapEntityToSharedMemory to pick up
            (entity as any)._ontologyMetadata = {
              ontologyClass: classification.ontologyMetadata.ontologyClass,
              ontologyVersion: classification.ontologyMetadata.ontologyVersion || '1.0',
              classificationConfidence: classification.ontologyMetadata.classificationConfidence,
              classificationMethod: classification.ontologyMetadata.classificationMethod,
              ontologySource: classification.ontologyMetadata.ontologySource || 'lower',
              classifiedAt: classification.ontologyMetadata.classifiedAt || new Date().toISOString(),
            };
          }
        }

        const summary = classificationResult.summary;
        log(`[WaveController] Ontology classification for wave ${waveResult.wave}: ${summary.classifiedCount}/${summary.total} classified`, 'info', {
          byClass: summary.byClass,
          byMethod: summary.byMethod,
          llmCalls: summary.llmCalls,
        });

        return {
          classified: summary.classifiedCount,
          unclassified: summary.unclassifiedCount,
          byClass: summary.byClass,
        };
      }

      return { classified: 0, unclassified: allEntities.length, byClass: {} };
    } catch (error) {
      log(`[WaveController] Ontology classification failed for wave ${waveResult.wave}, using hierarchy-level fallback`, 'warning', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { classified: 0, unclassified: allEntities.length, byClass: {} };
    }
  }

  /**
   * Map KGEntity to SharedMemoryEntity format.
   *
   * CRITICAL: Correct field mapping (see RESEARCH.md Pitfall 1 and Pitfall 6):
   * - entityType comes from KGEntity.type (not entityType -- KGEntity has `type`)
   * - hierarchyLevel comes from KGEntity.level
   * - parentEntityName comes from KGEntity.parentId
   * - Ontology metadata uses real classification from classifyWaveEntities() if available,
   *   falling back to hierarchy-level classification only as last resort.
   */
  private mapEntityToSharedMemory(entity: KGEntity): SharedMemoryEntity {
    // Check for real ontology classification attached by classifyWaveEntities()
    const realOntology = (entity as any)._ontologyMetadata;
    const hierarchyClass = this.getHierarchyLevelName(entity.level);

    return {
      id: entity.id,
      name: entity.name,
      entityType: entity.type, // KGEntity uses `type`, SharedMemoryEntity uses `entityType`
      significance: entity.significance,
      observations: entity.observations,
      relationships: [],
      metadata: {
        created_at: new Date().toISOString(),
        last_updated: new Date().toISOString(),
        team: this.team,
        source: 'wave-analysis',
        ontology: realOntology
          ? {
              ontologyName: realOntology.ontologyClass,
              ontologyClass: realOntology.ontologyClass,
              ontologyVersion: realOntology.ontologyVersion,
              confidence: realOntology.classificationConfidence,
              classificationConfidence: realOntology.classificationConfidence,
              classificationMethod: realOntology.classificationMethod,
              ontologySource: realOntology.ontologySource,
              classifiedAt: realOntology.classifiedAt,
            }
          : {
              ontologyName: hierarchyClass,
              ontologyClass: hierarchyClass,
              ontologyVersion: '1.0',
              confidence: 1.0,
              classificationConfidence: 1.0,
              classificationMethod: 'auto-assigned',
              ontologySource: 'lower' as const,
              classifiedAt: new Date().toISOString(),
            },
      },
      hierarchyLevel: entity.level,
      parentEntityName: entity.parentId,
      childEntityNames: [],
      isScaffoldNode: (entity.level ?? 3) < 3, // L0, L1, L2 are scaffold nodes
      // Operator-enriched fields (set by conv, aggr, embed operators)
      ...(entity.embedding ? { embedding: entity.embedding } : {}),
      ...(entity.role ? { role: entity.role } : {}),
      ...(entity.enrichedContext ? { enrichedContext: entity.enrichedContext } : {}),
    };
  }

  /**
   * Map hierarchy level to human-readable name (for structural metadata only).
   * This is NOT the ontology classification — just the hierarchy level label.
   */
  private getHierarchyLevelName(level?: number): string {
    switch (level) {
      case 0: return 'Project';
      case 1: return 'Component';
      case 2: return 'SubComponent';
      case 3: return 'Detail';
      default: return 'Detail';
    }
  }

  // --------------------------------------------------------------------------
  // Insight Finalization
  // --------------------------------------------------------------------------

  /**
   * Generate insight documents for all entities produced by the wave pipeline.
   * Runs after all 3 waves complete and entities are persisted.
   * Each entity gets a markdown document; L1/L2 also get PlantUML diagrams.
   */
  private async generateInsightsForWaveEntities(
    waveResults: WaveResult[],
  ): Promise<{ generated: number; failed: number; skippedDiagrams: number }> {
    // Collect all entities and relationships from all waves
    const allEntities = waveResults.flatMap(wr => wr.agentOutputs.flatMap(ao => ao.entities));
    const allRelationships = waveResults.flatMap(wr => wr.agentOutputs.flatMap(ao => ao.relationships));

    log('[WaveController] Starting insight finalization', 'info', {
      entityCount: allEntities.length,
      relationshipCount: allRelationships.length,
    });

    if (allEntities.length === 0) {
      log('[WaveController] No entities to generate insights for', 'warning');
      return { generated: 0, failed: 0, skippedDiagrams: 0 };
    }

    // In mock mode, skip real insight generation (it makes LLM calls)
    if (isMockLLMEnabled(this.repositoryPath)) {
      const mockDelay = getMockDelay(this.repositoryPath);
      await new Promise(resolve => setTimeout(resolve, mockDelay));
      log('[WaveController] Mock mode: skipping insight generation', 'info', { entityCount: allEntities.length });
      return { generated: allEntities.length, failed: 0, skippedDiagrams: 0 };
    }

    // Instantiate InsightGenerationAgent ONCE (constructor creates dirs, checks PlantUML)
    const insightAgent = new InsightGenerationAgent(this.repositoryPath);

    let generated = 0;
    let failed = 0;
    let skippedDiagrams = 0;
    const planned = allEntities.length;

    // Emit the plan upfront so the dashboard's Insight Generation panel
    // can render "0/<planned>" instead of waiting until wave completion.
    // captureStepMetrics at the end of the wave will overwrite this with
    // the authoritative tally (which is the same numbers in steady state).
    this.updateStepOutputs('wave4_insights', {
      planned,
      generated: 0,
      failed: 0,
      skippedDiagrams: 0,
    });

    // Build insight generation tasks (one per entity)
    this.resetItemProgressThrottle();
    const insightTasks = allEntities.map(entity => {
      return async (): Promise<void> => {
        try {
          // Build cross-reference context
          const crossReferences = this.buildCrossReferences(entity, allEntities);

          // L1/L2 get diagrams; L0 too broad, L3 too granular (Phase 14 overrides Phase 9 all-levels decision)
          const entityLevel = (entity as any).hierarchyLevel ?? (entity as any).level;
          const generateDiagrams = entityLevel === 1 || entityLevel === 2;

          // Build relations for this entity
          const entityRelations = allRelationships
            .filter(r => r.from === entity.name || r.to === entity.name)
            .map(r => ({ from: r.from, to: r.to, relationType: r.type }));

          // Enrich observations with analysis artifacts from SemanticAnalysisAgent
          const artifacts = (entity as any)._analysisArtifacts;
          let enrichedObservations = [...entity.observations];
          if (artifacts) {
            if (artifacts.patterns?.length > 0) {
              enrichedObservations.push(`[Architectural Patterns] ${artifacts.patterns.join('; ')}`);
            }
            if (artifacts.architectureNotes?.length > 0) {
              enrichedObservations.push(`[Architecture Notes] ${artifacts.architectureNotes.join('; ')}`);
            }
            if (artifacts.codeReferences?.length > 0) {
              enrichedObservations.push(`[Code References] ${artifacts.codeReferences.join('; ')}`);
            }
          }

          process.stderr.write(`[WaveController] Insight: ${entity.name} level=${entityLevel} diagrams=${generateDiagrams}\n`);

          const result = await insightAgent.generateEntityInsight({
            entityName: entity.name,
            entityType: entity.type,
            observations: enrichedObservations,
            relations: entityRelations,
            crossReferences,
            generateDiagrams,
          });

          process.stderr.write(`[WaveController] Result: ${entity.name} success=${result.success} diagramCount=${result.diagramCount}\n`);

          if (result.success) {
            generated++;

            // Track skipped diagrams (L1/L2 that got fewer than 2 diagrams: architecture + relationship)
            if (generateDiagrams && result.diagramCount < 2) {
              skippedDiagrams++;
            }

            // Emit progress event per entity to keep lastUpdate fresh (prevents stale detection)
            dispatch({ type: 'substep-update', substepId: 'wave4_insights', wave: 4, totalWaves: 4 });
            // Tick the live counter so the dashboard's Insight Generation
            // panel can render "N/<planned>" while wave4 is running.
            this.updateStepOutputs('wave4_insights', { planned, generated, failed, skippedDiagrams, itemsCompleted: generated + failed, itemsTotal: planned });

            // Update entity metadata with insight document path
            // Phase 42.2 Plan 04 — route through the km-core adapter
            // (replaces the legacy graphDB.storeEntity call). storeEntity
            // upserts when an entity with the same name already exists,
            // preserving the existing behavior of this metadata stamp.
            try {
              if (this.kmCoreAdapter) {
                await this.kmCoreAdapter.storeEntity(
                  {
                    name: entity.name,
                    entityType: entity.type,
                    observations: entity.observations,
                    significance: entity.significance,
                    metadata: {
                      validated_file_path: result.filePath,
                      has_insight_document: true,
                    },
                  },
                  { team: this.team },
                );
              } else {
                log(`[WaveController] km-core adapter not bootstrapped; cannot stamp insight metadata for ${entity.name}`, 'warning');
              }
            } catch (updateErr) {
              log(`[WaveController] Failed to update metadata for ${entity.name}: ${updateErr}`, 'warning');
            }
          } else {
            failed++;
            this.updateStepOutputs('wave4_insights', { planned, generated, failed, skippedDiagrams, itemsCompleted: generated + failed, itemsTotal: planned });
          }
        } catch (entityErr) {
          log(`[WaveController] Insight generation failed for ${entity.name}: ${entityErr}`, 'warning');
          failed++;
          this.updateStepOutputs('wave4_insights', { planned, generated, failed, skippedDiagrams, itemsCompleted: generated + failed, itemsTotal: planned });
        }
      };
    });

    // Execute with bounded concurrency (2 parallel to be conservative with LLM rate limits)
    await this.runWithConcurrency(insightTasks, 2);

    return { generated, failed, skippedDiagrams };
  }

  /**
   * Build cross-reference context for an entity from the full entity set.
   * Extracts parent, children, and siblings for dual cross-reference generation.
   */
  private buildCrossReferences(
    entity: KGEntity,
    allEntities: KGEntity[],
  ): CrossReferenceContext {
    const parent = entity.parentId
      ? allEntities.find(e => e.name === entity.parentId)
      : undefined;

    const children = allEntities.filter(e => e.parentId === entity.name);

    const siblings = entity.parentId
      ? allEntities.filter(e => e.parentId === entity.parentId && e.name !== entity.name)
      : [];

    return {
      parent: parent
        ? { name: parent.name, firstObservation: parent.observations[0] || 'No observations available' }
        : undefined,
      children: children.map(c => ({
        name: c.name,
        firstObservation: c.observations[0] || 'No observations available',
      })),
      siblings: siblings.map(s => ({
        name: s.name,
        firstObservation: s.observations[0] || 'No observations available',
      })),
    };
  }

  // --------------------------------------------------------------------------
  // Concurrency Control
  // --------------------------------------------------------------------------

  /**
   * Run tasks with bounded concurrency using work-stealing pattern.
   * Starts maxConcurrent workers; each pulls next task when done.
   * Results are returned in original order.
   *
   * If failFast is true and any task throws, remaining tasks are skipped.
   */
  private async runWithConcurrency<T>(
    tasks: Array<() => Promise<T>>,
    maxConcurrent: number,
    onTaskComplete?: (index: number, result: T) => void,
  ): Promise<T[]> {
    if (tasks.length === 0) return [];

    const results: T[] = new Array(tasks.length);
    let nextIndex = 0;
    let hasError = false;
    let firstError: Error | null = null;

    const worker = async (): Promise<void> => {
      while (nextIndex < tasks.length) {
        if (hasError && this.failFast) return;

        const taskIndex = nextIndex++;
        if (taskIndex >= tasks.length) return;

        try {
          results[taskIndex] = await tasks[taskIndex]();
          // Fire completion callback for incremental progress updates
          if (onTaskComplete) {
            try { onTaskComplete(taskIndex, results[taskIndex]); } catch { /* non-fatal */ }
          }
        } catch (error) {
          if (!hasError) {
            hasError = true;
            firstError = error instanceof Error ? error : new Error(String(error));
          }
          if (this.failFast) return;
        }
      }
    };

    // Start up to maxConcurrent workers
    const workerCount = Math.min(maxConcurrent, tasks.length);
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.all(workers);

    if (hasError && this.failFast && firstError) {
      throw firstError;
    }

    return results;
  }

  // --------------------------------------------------------------------------
  // Progress & Logging
  // --------------------------------------------------------------------------

  /**
   * Log a visible wave banner for progress visibility.
   */
  private logWaveBanner(wave: string, description: string): void {
    const line = '='.repeat(60);
    log(line, 'info');
    log(`=== ${wave}: ${description} ===`, 'info');
    log(line, 'info');
  }

  /**
   * Get recent git commits for BatchContext.
   */
  private async getRecentGitCommits(days: number): Promise<Array<{ hash: string; message: string; date: Date }>> {
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);

      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const { stdout } = await execFileAsync('git', [
        'log', `--since=${since}`, '--format=%H|%s|%aI', '--max-count=50',
      ], { cwd: this.repositoryPath, timeout: 10000 });

      return stdout.trim().split('\n').filter(Boolean).map(line => {
        const [hash, message, dateStr] = line.split('|');
        return { hash, message, date: new Date(dateStr) };
      });
    } catch {
      return []; // Git not available or no commits -- non-fatal
    }
  }

  /**
   * Get recent session files for BatchContext.
   */
  private getRecentSessions(days: number): Array<{ filename: string; timestamp: Date }> {
    try {
      const sessionsDir = path.join(this.repositoryPath, '.specstory', 'history');
      if (!fs.existsSync(sessionsDir)) return [];

      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      return fs.readdirSync(sessionsDir)
        .filter(f => f.endsWith('.md'))
        .map(f => {
          const dateStr = f.substring(0, 10); // YYYY-MM-DD prefix
          return { filename: f, timestamp: new Date(dateStr) };
        })
        .filter(s => s.timestamp.getTime() >= cutoff);
    } catch {
      return [];
    }
  }

  /**
   * Ordered sequence of sub-steps across all waves.
   * Each step name maps to an agent ID in the dashboard's STEP_TO_AGENT.
   * This gives the multi-agent graph fine-grained progress visibility.
   */
  private static readonly WAVE_STEP_SEQUENCE = [
    { name: 'wave1_init',      wave: 1, phase: 'init' as const },
    { name: 'wave1_analyze',   wave: 1, phase: 'analyze' as const },
    { name: 'wave1_classify',  wave: 1, phase: 'classify' as const },
    { name: 'wave1_persist',   wave: 1, phase: 'persist' as const },
    { name: 'wave2_analyze',   wave: 2, phase: 'analyze' as const },
    { name: 'wave2_classify',  wave: 2, phase: 'classify' as const },
    { name: 'wave2_persist',   wave: 2, phase: 'persist' as const },
    { name: 'wave3_analyze',   wave: 3, phase: 'analyze' as const },
    { name: 'wave3_classify',  wave: 3, phase: 'classify' as const },
    { name: 'wave3_persist',   wave: 3, phase: 'persist' as const },
    { name: 'operator_conv',   wave: 3, phase: 'operators' as const },
    { name: 'operator_aggr',   wave: 3, phase: 'operators' as const },
    { name: 'operator_embed',  wave: 3, phase: 'operators' as const },
    { name: 'operator_dedup',  wave: 3, phase: 'operators' as const },
    { name: 'operator_pred',   wave: 3, phase: 'operators' as const },
    { name: 'operator_merge',  wave: 3, phase: 'operators' as const },
    { name: 'wave4_insights',  wave: 4, phase: 'insights' as const },
  ];

  /**
   * Update the progress file with wave status.
   * Reports granular sub-steps per wave so the dashboard multi-agent graph
   * can light up the correct agents (semantic_analysis, persistence, etc.).
   * Preserves debug state fields (singleStepMode, mockLLM, llmState).
   */
  /**
   * Check if single-step mode is enabled and pause until user advances.
   * Reads singleStepMode from progress file, sets stepPaused=true, polls for resume.
   */
  private async checkSingleStepPause(stepName: string, isSubstep: boolean = false): Promise<void> {
    try {
      if (!fs.existsSync(this.progressFile)) return;

      let progress = JSON.parse(fs.readFileSync(this.progressFile, 'utf8'));

      // Top-level fields are authoritative WHEN SET (written by user's latest action via REST/WS).
      // Fall back to config.* when top-level is undefined (initial workflow start only sets config).
      const singleStepEnabled = progress.singleStepMode !== undefined
        ? progress.singleStepMode
        : progress.config?.singleStepMode;
      if (!singleStepEnabled) {
        log(`[Step] SKIP '${stepName}' (singleStepMode off: top=${progress.singleStepMode}, config=${progress.config?.singleStepMode})`, 'debug');
        return;
      }

      // For sub-steps, only pause if stepIntoSubsteps is enabled
      if (isSubstep) {
        await new Promise(resolve => setTimeout(resolve, 100)); // 100ms to allow file writes to settle
        try {
          const raw = fs.readFileSync(this.progressFile, 'utf8');
          const freshProgress = JSON.parse(raw);
          // Top-level is authoritative when set; fall back to config for initial state
          const topVal = freshProgress.stepIntoSubsteps;
          const cfgVal = freshProgress.config?.stepIntoSubsteps;
          const stepInto = topVal !== undefined ? topVal : cfgVal;
          log(`[Step] CHECK sub-step '${stepName}': stepInto decision=${stepInto} (top=${topVal}, config=${cfgVal})`, 'info');
          if (!stepInto) {
            log(`[Step] SKIP sub-step '${stepName}' (stepIntoSubsteps=false)`, 'info');
            return;
          }
          progress = freshProgress;
        } catch (e) {
          log(`[Step] CHECK sub-step '${stepName}': file read error: ${e}`, 'warning');
          const stepInto = progress.stepIntoSubsteps;
          if (!stepInto) return;
        }
      }

      // When pausing at a MAJOR step (not a sub-step), reset stepIntoSubsteps to true.
      // This ensures sub-steps are shown and "Into" is available at each major step.
      // "Step" (stepInto=false) is a ONE-SHOT skip for the current step's sub-steps only.
      if (!isSubstep) {
        try {
          const resetProgress = JSON.parse(fs.readFileSync(this.progressFile, 'utf8'));
          resetProgress.stepIntoSubsteps = true;
          fs.writeFileSync(this.progressFile, JSON.stringify(resetProgress, null, 2));
        } catch { /* best-effort */ }
      }

      log(`[Step] PAUSE at ${isSubstep ? 'sub-step' : 'STEP'} '${stepName}' (singleStep=${singleStepEnabled}, stepInto=${progress.stepIntoSubsteps || progress.config?.stepIntoSubsteps})`, 'info');

      // Re-read progress file to get latest state (other writers may have updated it)
      // then ONLY set pause fields. This prevents overwriting user changes (stepIntoSubsteps, etc.)
      try {
        const latest = JSON.parse(fs.readFileSync(this.progressFile, 'utf8'));
        latest.stepPaused = true;
        latest.pausedAtStep = stepName;
        latest.pausedAt = new Date().toISOString();
        fs.writeFileSync(this.progressFile, JSON.stringify(latest, null, 2));
      } catch {
        // Fall back to writing with current progress object
        progress.stepPaused = true;
        progress.pausedAtStep = stepName;
        progress.pausedAt = new Date().toISOString();
        fs.writeFileSync(this.progressFile, JSON.stringify(progress, null, 2));
      }
    } catch (initError) {
      log(`[Step] File access failed at '${stepName}', skipping pause: ${initError}`, 'warning');
      return;
    }

    // Poll for resume signal
    const pollIntervalMs = 500;
    let lastLogTime = Date.now();
    const logIntervalMs = 30_000; // 30 seconds (was 5 min — too long for debugging)

    while (true) {
      let currentProgress: Record<string, any>;
      try {
        currentProgress = JSON.parse(fs.readFileSync(this.progressFile, 'utf8'));
      } catch {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        continue;
      }

      // Single-step mode disabled — resume to continuous mode
      const stillEnabled = currentProgress.singleStepMode !== undefined
        ? currentProgress.singleStepMode
        : currentProgress.config?.singleStepMode;
      if (!stillEnabled) {
        log(`[Step] RESUME (continuous mode) — singleStepMode disabled while paused at '${stepName}'`, 'info');
        return;
      }

      // stepPaused cleared — user clicked Step/Into
      if (!currentProgress.stepPaused) {
        const newStepInto = currentProgress.config?.stepIntoSubsteps || currentProgress.stepIntoSubsteps;
        log(`[Step] ADVANCE from '${stepName}' (stepInto=${newStepInto})`, 'info');
        return;
      }

      if (Date.now() - lastLogTime > logIntervalMs) {
        log(`[Step] Still paused at '${stepName}' (stepPaused=${currentProgress.stepPaused}, singleStep=${stillEnabled})`, 'debug');
        lastLogTime = Date.now();
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  }

  /**
   * Log a structured summary report of the wave execution.
   */
  private logSummaryReport(result: WaveExecutionResult): void {
    const line = '='.repeat(60);
    log(line, 'info');
    log('=== WAVE ANALYSIS SUMMARY ===', 'info');
    log(line, 'info');

    log(`Overall: ${result.success ? 'SUCCESS' : 'FAILED'}`, 'info');
    log(`Total entities: ${result.totalEntities}`, 'info');
    log(`  Manifest-defined: ${result.manifestEntities}`, 'info');
    log(`  Discovered: ${result.discoveredEntities}`, 'info');
    log(`Total duration: ${(result.totalDurationMs / 1000).toFixed(1)}s`, 'info');

    log('Entities by level:', 'info');
    for (const [level, count] of Object.entries(result.entitiesByLevel)) {
      const levelName = ['Project', 'Component', 'SubComponent', 'Detail'][Number(level)] ?? `L${level}`;
      log(`  L${level} (${levelName}): ${count}`, 'info');
    }

    for (const wave of result.waves) {
      log(`Wave ${wave.wave}: ${wave.success ? 'OK' : 'FAILED'} - ${wave.totalEntities} entities in ${(wave.durationMs / 1000).toFixed(1)}s`, 'info');
      if (wave.error) {
        log(`  Error: ${wave.error}`, 'error');
      }
    }

    log(line, 'info');
  }

  // --------------------------------------------------------------------------
  // Data Helpers
  // --------------------------------------------------------------------------

  /**
   * Load existing KG entities from the graph database.
   * Phase 42.2 Plan 04 — reads via the km-core adapter (which iterates the
   * canonical-shape store) instead of the retired GraphDatabaseAdapter.
   * GraphEntity cast is kept as the loose intermediate shape for the field
   * normalization below.
   */
  private async loadExistingEntities(): Promise<KGEntity[]> {
    try {
      if (!this.kmCoreAdapter) {
        log('[WaveController] km-core adapter not bootstrapped; loadExistingEntities returns empty', 'warning');
        return [];
      }
      const entities = await this.kmCoreAdapter.queryEntities();
      const graphEntities: GraphEntity[] = entities.map((e) => ({
        name: e.name,
        entityType: e.entityType,
        observations: (e.metadata as { observations?: unknown[] } | undefined)?.observations,
        significance: (e.metadata as { significance?: number } | undefined)?.significance,
        metadata: (e.metadata ?? {}) as Record<string, unknown>,
      }));

      return graphEntities.map((ge: GraphEntity): KGEntity => ({
        id: ge.name,
        name: ge.name,
        type: ge.entityType ?? 'Unknown',
        observations: Array.isArray(ge.observations)
          ? ge.observations.map((obs: unknown) =>
              typeof obs === 'string' ? obs : (obs as Record<string, string>)?.content ?? String(obs))
          : [],
        significance: ge.significance ?? 5,
        parentId: ge.metadata?.parentEntityName as string | undefined,
        level: ge.metadata?.hierarchyLevel as number | undefined,
        hierarchyPath: ge.metadata?.hierarchyPath as string | undefined,
      }));
    } catch (error) {
      log('[WaveController] Failed to load existing entities, continuing with empty set', 'warning', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Build the final WaveExecutionResult summary from all wave results.
   */
  private buildSummaryReport(
    startTime: number,
    waveResults: WaveResult[],
  ): WaveExecutionResult {
    const entitiesByLevel: Record<number, number> = {};

    for (const wave of waveResults) {
      for (const output of wave.agentOutputs) {
        for (const entity of output.entities) {
          const level = entity.level ?? 3;
          entitiesByLevel[level] = (entitiesByLevel[level] ?? 0) + 1;
        }
      }
    }

    const totalEntities = waveResults.reduce((sum, w) => sum + w.totalEntities, 0);
    const manifestEntities = waveResults.reduce((sum, w) => sum + w.manifestEntities, 0);
    const discoveredEntities = waveResults.reduce((sum, w) => sum + w.discoveredEntities, 0);
    const allSuccess = waveResults.every(w => w.success);

    return {
      success: allSuccess,
      waves: waveResults,
      totalEntities,
      totalDurationMs: Date.now() - startTime,
      entitiesByLevel,
      manifestEntities,
      discoveredEntities,
      error: allSuccess ? undefined : waveResults.find(w => !w.success)?.error,
    };
  }

  /**
   * Get component files via code-graph-rag Cypher queries.
   * Uses Memgraph's File nodes to find files associated with a component.
   * Gracefully falls back to empty array if CGR is unavailable.
   */
  private async getComponentFiles(componentName: string, keywords: string[]): Promise<string[]> {
    try {
      const { CodeGraphAgent } = await import('./code-graph-agent.js');
      const cgrAgent = new CodeGraphAgent();

      // Build a Cypher query to find files related to this component by name/keywords
      const cypher = `MATCH (f:File) WHERE toLower(f.file_path) CONTAINS toLower('${componentName}') OR ANY(k IN ['${keywords.join("','")}'] WHERE toLower(f.file_path) CONTAINS toLower(k)) RETURN f.file_path AS path LIMIT 50`;

      const result = await cgrAgent.runCypherQuery(cypher);
      const files = Array.isArray(result)
        ? result.map((r: Record<string, string>) => r.path).filter(Boolean)
        : [];

      log(`[WaveController] CGR found ${files.length} files for ${componentName}`, 'info');
      return files;
    } catch (error) {
      log(`[WaveController] CGR query failed for ${componentName}, falling back to empty file list`, 'warning', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}
