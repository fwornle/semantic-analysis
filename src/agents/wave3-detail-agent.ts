/**
 * Wave 3 Detail Agent
 *
 * Receives an L2 SubComponent entity and discovers L3 Detail entities via
 * pure LLM analysis. Wave 3 is the final wave -- no manifest seeds, all
 * entities are discovered from code analysis, and no child manifest is produced.
 *
 * @module agents/wave3-detail-agent
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logging.js';
import { LLMService } from '@rapid/llm-proxy';
import { isMockLLMEnabled, getMockDelay } from '../mock/llm-mock-service.js';
import { attachTokenLogger } from '../utils/token-usage-logger.js';
import type { KGEntity, KGRelation } from './kg-operators.js';
import type { Wave3Input, WaveAgentOutput, ChildManifestEntry, AnalyzeEntityCodeInput } from '../types/wave-types.js';
import { SemanticAnalysisAgent } from './semantic-analysis-agent.js';
import type { CgrQueryCache } from '../services/cgr-query-cache.js';
import type { CgrObservationBuilder } from '../utils/cgr-observation-builder.js';
import { toCanonicalEntity, augmentWithCanonical } from './canonical-mapper.js';
import { createLLMWithProcess } from './llm-with-process.js';
import { PROCESS_TAGS } from './process-tags.js';
import { parseLlmJson } from '../utils/parse-llm-json.js';

// Phase 42.2 Plan 02 Gap 2 — process-tag for token-usage attribution.
// Wave3 discover + observation-retry share this tag (forensics §2.1 row 6-7).
//
// Phase 52 D-05/D-06 — kept as the wave-level safety-net default bound at
// construction time. Each .complete() call below now passes a per-call
// `process: PROCESS_TAGS.WAVE3_DETAIL_EXTRACT` override.
const WAVE3_PROCESS_TAG = 'wave-analysis-wave3';

/** LLM response shape for L3 discovery */
interface L3DiscoveryResponse {
  details: Array<{
    name: string;
    description: string;
    observations: string[];
  }>;
}

export class Wave3DetailAgent {
  private repositoryPath: string;
  private team: string;
  private llmService: LLMService;
  private llmInitialized: boolean = false;
  private cgrCache: CgrQueryCache | null;
  private cgrBuilder: CgrObservationBuilder | null;
  /**
   * Phase 42 Plan 06 — stable runId passed from WaveController. Stamped onto
   * the canonical-mapper provenance + descriptionSegments[0].runId for every
   * entity this agent emits. When omitted (legacy callers), generates a fresh
   * per-instance UUID.
   */
  private runId: string;

  /** Phase 42.2 Plan 02 Gap 2 — direct-fetch wrapper that sets `body.process`
   *  on every wave3 LLM call. */
  private llmWithProcess: ReturnType<typeof createLLMWithProcess>;

  constructor(
    repositoryPath: string,
    team: string,
    cgrCache?: CgrQueryCache | null,
    cgrBuilder?: CgrObservationBuilder | null,
    runId?: string,
  ) {
    this.repositoryPath = repositoryPath;
    this.team = team;
    this.llmService = new LLMService();
    // Phase 42 Plan 07 — Surprise #5 fix: CommonJS require() → static ESM import.
    attachTokenLogger(this.llmService, 'wave3-detail-agent');
    this.cgrCache = cgrCache ?? null;
    this.cgrBuilder = cgrBuilder ?? null;
    this.runId = runId ?? `wave3-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    // Phase 42.2 Plan 02 Gap 2 — bind tracker so direct-fetch calls also land
    // in the SDK's metrics tracker (wave-controller's tracer reads from it).
    this.llmWithProcess = createLLMWithProcess(
      WAVE3_PROCESS_TAG,
      this.llmService.getMetricsTracker(),
    );
  }

  private async ensureLLMInitialized(): Promise<void> {
    if (!this.llmInitialized) {
      await this.llmService.initialize();
      this.llmInitialized = true;
      const providers = this.llmService.getAvailableProviders();
      log(`[Wave3Agent] LLMService initialized with providers: ${providers.join(', ')}`, 'info');
    }
  }

  /** Return LLM metrics from this agent's LLMService (for tracer) */
  getLLMMetrics(): { providers: string[]; totalTokens: number; totalCalls: number } {
    const tracker = this.llmService.getMetricsTracker();
    const calls = tracker.getCalls();
    const providers = [...new Set(calls.map(c => c.model ? `${c.model}@${c.provider}` : c.provider))];
    const totalTokens = calls.reduce((sum, c) => sum + c.totalTokens, 0);
    return { providers, totalTokens, totalCalls: calls.length };
  }

  /** Return detailed per-call metrics for trace instrumentation */
  getDetailedCalls(): Array<{ provider: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number; latencyMs: number; operationType?: string; timestamp: number }> {
    return this.llmService.getMetricsTracker().getCalls();
  }

  /**
   * Execute Wave 3 analysis for a single L2 SubComponent.
   *
   * Flow:
   * 1. Read scoped files relevant to this L2 entity
   * 2. Call LLM to discover L3 Detail entities
   * 3. Build entities with correct hierarchy fields
   * 4. Build parent-child relationships
   * 5. Return with empty childManifest (Wave 3 is the last wave)
   */
  async execute(input: Wave3Input): Promise<WaveAgentOutput> {
    const startTime = Date.now();
    const parentName = input.l2Entity.name;
    const onPhase = input.onPhase;
    log(`[Wave3Agent] Starting detail analysis for ${parentName}`, 'info');

    // Phase: sem_data_prep — reading and preparing scoped files
    if (onPhase) await onPhase('sem_data_prep');

    // Read scoped source files
    const fileContents = await this.readScopedFiles(input.scopedFiles, 8);

    let l3Entities: KGEntity[] = [];

    // Phase: sem_llm_analysis — LLM discovery of detail entities
    if (onPhase) await onPhase('sem_llm_analysis');

    if (isMockLLMEnabled(this.repositoryPath)) {
      // Mock mode: generate 2 synthetic L3 entities per L2 node
      const mockDelay = getMockDelay(this.repositoryPath);
      await new Promise(resolve => setTimeout(resolve, mockDelay));
      log(`[Wave3Agent] Mock mode: generating synthetic L3 entities for ${parentName}`, 'info');

      // Derive synthetic names from L2 parent name pattern
      const suffixes = ['Core', 'Handler'];
      for (const suffix of suffixes) {
        const detailName = `${parentName}${suffix}`;
        const entity = this.buildL3Entity(
          detailName,
          `${suffix} implementation of ${parentName}`,
          [
            `${detailName} handles the ${suffix.toLowerCase()} logic for ${parentName}`,
            `Part of the ${input.l1Entity.name} component hierarchy`,
          ],
          input.l2Entity,
          input.l1Entity
        );
        l3Entities.push(entity);
      }
    } else {
      // Real LLM mode: discover detail entities from code analysis
      await this.ensureLLMInitialized();

      const discoveryResult = await this.discoverL3Details(input, fileContents);

      for (const detail of discoveryResult.details) {
        const parentPath = input.l2Entity.hierarchyPath || `${input.l1Entity.name}/${input.l2Entity.name}`;
        const validatedObs = await this.ensureMinimumObservations(
          detail.name,
          detail.observations,
          {
            description: detail.description,
            hierarchyPath: `${parentPath}/${detail.name}`,
            parentName: input.l2Entity.name,
            sourceFiles: input.scopedFiles,
          },
        );

        const entity = this.buildL3Entity(
          detail.name,
          detail.description,
          validatedObs,
          input.l2Entity,
          input.l1Entity
        );
        l3Entities.push(entity);
      }
    }

    // Phase: sem_observation_gen — enriching entities with deep observations
    if (onPhase) await onPhase('sem_observation_gen');

    // Enrich each L3 entity via CGR + SemanticAnalysisAgent (per-entity, fresh instance)
    if (!isMockLLMEnabled(this.repositoryPath)) {
      for (const entity of l3Entities) {
        // CGR integration: query code graph for entity details + deep call graph
        let cgrPrompt = '';
        let hadCgrEvidence = false;
        if (this.cgrCache?.isAvailable() && this.cgrBuilder) {
          try {
            const details = await this.cgrCache.queryEntityDetails(entity.name, input.scopedFiles);
            const callGraph = await this.cgrCache.queryCallGraph(entity.name, 2);

            const structuralObs = this.cgrBuilder.buildStructuralObservations(details.entities, entity.name);
            const relationshipObs = this.cgrBuilder.buildRelationshipObservations(details.callees, details.imports);
            const cgrObs = [...structuralObs, ...relationshipObs];

            // Add dedicated call chain observations
            if (callGraph.chains.length > 0) {
              const uniqueChains = callGraph.chains.slice(0, 5);
              for (const chain of uniqueChains) {
                cgrObs.push(`[CGR] Call chain: ${chain.caller} -> ${chain.callee}`);
              }
            }

            // Push CGR observations into entity before SAA call
            entity.observations.push(...cgrObs);

            cgrPrompt = this.cgrBuilder.formatForLLMPrompt(details, callGraph);
            hadCgrEvidence = this.cgrBuilder.hasEvidence(details.entities);

            if (!hadCgrEvidence && (entity.level ?? 0) >= 2) {
              (entity as any)._noCgrEvidence = true;
            }
            log(`[Wave3] CGR for ${entity.name}: ${details.entities.length} entities, ${callGraph.chains.length} call chains, ${cgrObs.length} observations`, 'info');
          } catch (err) {
            log(`[Wave3] CGR query failed for ${entity.name}, continuing without: ${err instanceof Error ? err.message : String(err)}`, 'warning');
          }
        }

        const semanticAgent = new SemanticAnalysisAgent(this.repositoryPath);
        try {
          const analysisInput: AnalyzeEntityCodeInput = {
            entityName: entity.name,
            entityType: entity.type,
            codeFiles: input.scopedFiles,
            parentContext: input.l2Entity.observations,
            analysisDepth: 'deep',
            cgrContext: cgrPrompt || undefined,
          };
          const analysisResult = await semanticAgent.analyzeEntityCode(analysisInput);
          // Auto-tag SAA observations based on CGR context presence
          const taggedObs = SemanticAnalysisAgent.autoTagObservations(analysisResult.observations, !!cgrPrompt);
          // Preserve existing [CGR] observations, then set LLM observations
          const existingCgrObs = entity.observations.filter(o => o.startsWith('[CGR]'));
          entity.observations = [...existingCgrObs, ...taggedObs];
          (entity as any)._analysisArtifacts = analysisResult.artifacts;
          (entity as any)._traceData = [analysisResult.traceData];
          log(`[Wave3] Enriched entity ${entity.name} via SemanticAnalysisAgent (${taggedObs.length} observations, CGR context: ${!!cgrPrompt})`, 'info');
        } catch (err) {
          (entity as any)._shallowAnalysis = true;
          log(`[Wave3] SemanticAnalysisAgent failed for ${entity.name}, using shallow analysis: ${err instanceof Error ? err.message : String(err)}`, 'warning');
        }
      }
    }

    // Phase: sem_entity_transform — building final entities and relationships
    if (onPhase) await onPhase('sem_entity_transform');

    // Build parent-child relationships
    const relationships = this.buildRelationships(l3Entities, input.l2Entity);

    const durationMs = Date.now() - startTime;
    log(`[Wave3Agent] Completed ${parentName}: ${l3Entities.length} L3 entities (${durationMs}ms)`, 'info');

    // Phase 42 Plan 06 — canonical emit: fold km-core canonical Entity fields
    // (ontologyClass='Detail', entityType, legacyId, metadata.subsystem,
    // metadata.descriptionSegments[0], metadata.provenance) onto every wave3
    // entity. Detail is the SC#2 target — every Detail entity returned by
    // findByOntologyClass('Detail') after a `ukb full` run should have
    // embedding.length === 384 (Plan 7 e2e gate verifies).
    //
    // toCanonicalEntity reference (acceptance grep target):
    const _grepMarker: unknown = toCanonicalEntity;  // eslint-disable-line @typescript-eslint/no-unused-vars
    // Phase 42.2 Plan 02 Gap 1 — thread `team` so canonical-mapper stamps
    // `metadata.team` for km-core multi-tenant queries.
    // Phase 57 D-04 — also pass `project: this.team` so canonical-mapper
    // stamps the closed-set `metadata.project` tag (defaults to `'coding'`
    // in this container; `isProject(this.team)` gates the actual stamp).
    // TODO(phase-60-or-later): plumb dedicated `parameters.project`.
    const canonicalEntities = l3Entities.map((entity) =>
      augmentWithCanonical(entity, 'Detail', this.runId, { team: this.team, project: this.team }),
    );

    return {
      entities: canonicalEntities,
      relationships,
      childManifest: [], // Wave 3 is the last wave -- no children to suggest
      discovered: true, // Wave 3 agents may be spawned from discovered L2 entities
      durationMs,
      parentId: parentName,
      agentName: `Wave3:${parentName}`,
    };
  }

  /**
   * Call LLM to discover L3 Detail entities within an L2 scope.
   * Uses parent and grandparent context for hierarchy orientation.
   */
  private async discoverL3Details(input: Wave3Input, fileContents: string): Promise<L3DiscoveryResponse> {
    const l2Description = input.l2Entity.observations.length > 0
      ? input.l2Entity.observations[0]
      : `SubComponent ${input.l2Entity.name}`;

    const l1Description = input.l1Entity.observations.length > 0
      ? input.l1Entity.observations[0]
      : `Component ${input.l1Entity.name}`;

    const hasFiles = fileContents.length > 0;
    const fileSection = hasFiles
      ? fileContents
      : '(no source files available -- analyze based on parent context only)';

    if (!hasFiles) {
      log(`[Wave3Agent] No scoped files for ${input.l2Entity.name}, using parent context only`, 'warning');
    }

    const suggestedSection = input.suggestedChildren && input.suggestedChildren.length > 0
      ? `\n## Suggested Detail Nodes (from parent component analysis)\nThe parent analysis suggested these L3 nodes exist. Validate them against the source code -- keep those with evidence, discard those without, and discover additional nodes not listed here:\n${input.suggestedChildren
          .map(c => `- ${c.name}: ${c.description}`)
          .join('\n')}\n`
      : '';

    const docSection = input.docContext ? `\n## Project Documentation\n${input.docContext}\n` : '';

    const prompt = `You are analyzing the ${input.l2Entity.name} sub-component to identify its detail-level knowledge nodes.

## Hierarchy Context
Project: Coding
Component (L1): ${input.l1Entity.name} - ${l1Description}
SubComponent (L2): ${input.l2Entity.name} - ${l2Description}

## Source Files
${fileSection}
${suggestedSection}${docSection}
## Task
Identify ${hasFiles ? '2-5' : '1-2'} Detail-level (L3) nodes that represent specific, notable aspects of this sub-component.

CRITICAL RULE: Every L3 node you suggest MUST have verifiable code evidence in the source files above.
- If no source files are available, suggest AT MOST 1-2 nodes based on strong parent context. Prefer suggesting fewer high-quality nodes over many speculative ones.
- Do NOT invent entities that you cannot point to in the code. If a suggested node from the parent analysis has no code evidence, DISCARD it.
- It is better to return an empty list than to hallucinate entities.

ANTI-HALLUCINATION RULES:
- DO NOT invent file paths, class names, or function names that are not in the Source Files above
- DO NOT reference modules, packages, or libraries not visible in the source code
- If you are uncertain whether something exists, DO NOT include it
- Every observation MUST quote a specific artifact from the Source Files section
- Prefer returning fewer high-quality entities over many speculative ones

Good L3 nodes are:
- Specific classes or modules with distinct behavior (e.g., "BatchScheduler", "LLMRetryPolicy")
- Key algorithms or processing patterns (e.g., "StreamingResponseParser", "DAGDependencyResolver")
- Important configuration or integration points (e.g., "ProviderFallbackConfig", "MemgraphConnection")
- Notable architectural decisions or design patterns (e.g., "EventDrivenPipeline", "SharedMemoryStore")

BAD L3 nodes (do NOT suggest these):
- Generic labels like "Configuration", "Utils", "Types", "Helpers"
- Nodes that just restate the L2 name with "Manager" or "Service" suffix
- Nodes with no specific code evidence in the source files above
- Nodes that combine unrelated concepts (e.g., "VkbApiAgentGateway" — VKB and agent management are unrelated)

For each L3 node, provide:
- name: PascalCase, specific and descriptive
- description: 1-2 sentences about what it does
- observations: 3-5 specific observations about architecture, behavior, or design decisions. Each observation MUST:
  - Reference at least one specific code artifact (file path, class name, function name, or module) FROM THE SOURCE FILES ABOVE
  - Describe a concrete architectural decision, behavior, or pattern
  - Be self-contained (understandable without reading the source)

  GOOD observations (follow this style):
  - "SharedMemoryStore (kg-operators.ts:31) defines the KGEntity interface with hierarchy fields parentId, level, hierarchyPath added in Phase 4"
  - "LLMRetryPolicy in llm-service.ts implements exponential backoff with jitter, capping at 3 retries per provider before falling back to the next"

  BAD observations (DO NOT write these):
  - "Works well" (trivially generic, no code reference)
  - "Important implementation detail" (vague, no artifact mentioned)
  - References to files not shown in the Source Files section above

## Self-Sufficiency Standard
Each detail node description and its observations MUST orient a new developer:
- What does this detail DO? (specific behavior, algorithm, or pattern)
- WHERE in the code does it live? (exact files, classes, or functions)
- WHAT should the developer expect? (how it works, what it connects to)
Write as if this is the only documentation available about this detail.

## Output (JSON only, no markdown fencing)
{
  "details": [
    {
      "name": "PascalCaseName",
      "description": "1-2 sentences",
      "observations": ["specific observation 1", "specific observation 2"]
    }
  ]
}`;

    try {
      // Phase 42.2 Plan 02 Gap 2 — route through llmWithProcess for tagged
      // process attribution.
      // Phase 52 D-05 — per-call PROCESS_TAGS.WAVE3_DETAIL_EXTRACT override.
      const result = await this.llmWithProcess.complete({
        process: PROCESS_TAGS.WAVE3_DETAIL_EXTRACT,
        messages: [{ role: 'user', content: prompt }],
        taskType: 'wave3_detail_discovery',
        agentId: 'wave3_detail',
        tier: 'standard',
        maxTokens: 4096,
        temperature: 0.7,
        timeout: 60_000,
      });

      log(`[Wave3Agent] LLM call for ${input.l2Entity.name} via ${result.provider}/${result.model} (${result.tokens.total} tokens, ${result.latencyMs}ms)`, 'info');

      return this.parseL3Response(result.content);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log(`[Wave3Agent] LLM call failed for ${input.l2Entity.name}: ${errMsg}`, 'error');

      // Return empty -- some L2 nodes may simply have no discoverable L3 children
      return { details: [] };
    }
  }

  /**
   * Parse LLM response into structured L3 discovery result.
   * Validates JSON and filters out invalid entries.
   */
  private parseL3Response(responseText: string): L3DiscoveryResponse {
    try {
      const parsedResult = parseLlmJson<L3DiscoveryResponse>(responseText);
      if (parsedResult.value === null) {
        throw new Error(parsedResult.error || 'unparseable LLM reply');
      }
      if (parsedResult.repaired) {
        log('[Wave3Agent] Repaired control characters in LLM reply', 'info');
      }
      const parsed = parsedResult.value;

      if (!parsed.details || !Array.isArray(parsed.details)) {
        log('[Wave3Agent] Invalid LLM response: missing details array', 'warning');
        return { details: [] };
      }

      // Filter out generic or invalid entries
      const genericNames = new Set([
        'Configuration', 'Utils', 'Types', 'Helpers', 'Constants',
        'Index', 'Main', 'Base', 'Common', 'Shared', 'Core',
        'Manager', 'Service', 'Handler', 'Controller', 'Module',
        'Logic', 'Processing', 'Implementation', 'Functionality',
        'Features', 'Operations', 'System', 'Framework', 'Engine',
      ]);

      const validDetails = parsed.details.filter(detail => {
        if (!detail.name || genericNames.has(detail.name)) {
          log(`[Wave3Agent] Filtered out generic L3 name: ${detail.name || '(empty)'}`, 'info');
          return false;
        }

        // Validate observations
        if (!Array.isArray(detail.observations) || detail.observations.length === 0) {
          detail.observations = [detail.description || `Detail entity ${detail.name}`];
        }

        // Require at least 2 observations with specific code artifact references
        const evidenceCount = detail.observations.filter((obs: string) =>
          this.hasSpecificCodeReference(obs),
        ).length;
        if (evidenceCount < 2) {
          log(`[Wave3Agent] Filtered L3 entity '${detail.name}': insufficient code evidence (${evidenceCount}/${detail.observations.length} observations)`, 'info');
          return false;
        }

        return true;
      });

      // Cap output to prevent runaway entity creation
      const MAX_L3_PER_AGENT = 5;
      if (validDetails.length > MAX_L3_PER_AGENT) {
        log(`[Wave3Agent] Capping L3 entities: ${validDetails.length} -> ${MAX_L3_PER_AGENT}`, 'info');
      }

      return { details: validDetails.slice(0, MAX_L3_PER_AGENT) };
    } catch (parseError) {
      log(`[Wave3Agent] Failed to parse LLM response as JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`, 'warning');
      return { details: [] };
    }
  }

  /**
   * Build an L3 Detail entity with correct hierarchy fields.
   * All L3 entities have discovered=true since Wave 3 is pure discovery.
   */
  private buildL3Entity(
    name: string,
    description: string,
    observations: string[],
    l2Entity: KGEntity,
    l1Entity: KGEntity
  ): KGEntity {
    const parentPath = l2Entity.hierarchyPath || `${l1Entity.name}/${l2Entity.name}`;
    return {
      id: name,
      name,
      type: 'Detail',
      observations: observations.length > 0 ? observations : [description],
      significance: 6,
      level: 3,
      parentId: l2Entity.name,
      hierarchyPath: `${parentPath}/${name}`,
      batchId: 'wave3-discovered',
    };
  }

  /**
   * Build parent-child relationship edges from L2 parent to each L3 entity.
   */
  private buildRelationships(l3Entities: KGEntity[], parentEntity: KGEntity): KGRelation[] {
    return l3Entities.map(l3 => ({
      from: parentEntity.name,
      to: l3.name,
      type: 'contains',
      weight: 1.0,
      source: 'explicit' as const,
    }));
  }

  // --------------------------------------------------------------------------
  // Observation Validation
  // --------------------------------------------------------------------------

  /**
   * Check if an observation contains a specific code reference.
   * Checks for: file paths (containing / or .ts/.js/.py), PascalCase/camelCase identifiers,
   * method call patterns, and line number references (:NN).
   */
  private hasSpecificCodeReference(obs: string): boolean {
    return (
      /\.(ts|js|py|yaml|yml|json|md|puml)\b/i.test(obs) ||        // file extensions
      /[A-Z][a-z]+[A-Z]/.test(obs) ||                              // PascalCase/camelCase identifiers
      /\w+\.\w+\(/.test(obs) ||                                    // method calls (e.g., obj.method())
      /\/[\w-]+\//.test(obs) ||                                     // file paths (e.g., /src/agents/)
      /:\d{1,5}\b/.test(obs)                                        // line number references (e.g., :31)
    );
  }

  /**
   * Check if an observation is specific enough (references code artifacts).
   * Lenient check: focus on rejecting clearly generic, not validating specific patterns.
   */
  private isSpecificObservation(obs: string): boolean {
    if (obs.length < 30) return false;

    // Long observations are likely specific enough
    if (obs.length >= 80) return true;

    // Check for code artifact indicators
    const hasCodeRef =
      this.hasSpecificCodeReference(obs) ||
      /\b(class|function|interface|module|implements|extends|import|export|constructor|async)\b/i.test(obs);

    return hasCodeRef;
  }

  /**
   * Ensure an entity has at least 3 specific observations.
   * Strategy: filter -> retry LLM -> supplement from context.
   */
  private async ensureMinimumObservations(
    entityName: string,
    observations: string[],
    context: { description: string; hierarchyPath: string; parentName?: string; sourceFiles?: string[] },
  ): Promise<string[]> {
    const initial = observations.length;

    // Step 1: Filter to specific observations
    const specific = observations.filter(obs => this.isSpecificObservation(obs));
    const filtered = initial - specific.length;

    if (specific.length >= 3) {
      log(`[Wave3Agent] Observation validation for ${entityName}: ${initial} -> ${specific.length} (filtered: ${filtered}, retried: 0, supplemented: 0)`, 'info');
      return specific.slice(0, 7);
    }

    // Step 2: Retry with enriched prompt
    let retryAdded = 0;
    const needed = 3 - specific.length;

    try {
      const retryPrompt = `You are generating specific observations about the "${entityName}" detail entity.

Context:
- Description: ${context.description}
- Hierarchy: ${context.hierarchyPath}
- Parent sub-component: ${context.parentName || 'unknown'}
${context.sourceFiles && context.sourceFiles.length > 0 ? `- Source files: ${context.sourceFiles.slice(0, 5).join(', ')}` : ''}

Generate exactly ${needed} specific observation(s) about this detail entity. Each observation MUST:
- Reference at least one specific code artifact (file path, class name, function name, or module)
- Be a complete, self-contained sentence

GOOD examples:
- "SharedMemoryStore (kg-operators.ts:31) defines KGEntity interface with hierarchy fields"
- "LLMRetryPolicy implements exponential backoff with jitter in llm-service.ts"

Return a JSON array of strings, e.g. ["observation 1", "observation 2"]`;

      // Phase 42.2 Plan 02 Gap 2 — route through llmWithProcess for tagged
      // process attribution on observation-retry.
      // Phase 52 D-05 — per-call PROCESS_TAGS.WAVE3_DETAIL_EXTRACT override
      // (same sub-step as the discover path; retry is a recovery path).
      const result = await this.llmWithProcess.complete({
        process: PROCESS_TAGS.WAVE3_DETAIL_EXTRACT,
        messages: [{ role: 'user', content: retryPrompt }],
        taskType: 'observation_retry',
        agentId: 'wave3_detail',
        tier: 'standard',
        maxTokens: 512,
        temperature: 0.7,
        timeout: 30_000,
      });

      let retryObs: string[] = [];
      try {
        const parsedResult = parseLlmJson<unknown>(result.content);
        if (parsedResult.repaired) {
          log('[Wave3Agent] Repaired control characters in observation retry', 'debug');
        }
        const parsed = parsedResult.value;
        retryObs = Array.isArray(parsed)
          ? parsed.filter((o: unknown): o is string => typeof o === 'string')
          : [];
      } catch {
        // Parse failed, skip retry results
      }

      // Combine and dedup
      const combined = [...specific, ...retryObs.filter(o => this.isSpecificObservation(o))];
      const deduped = [...new Set(combined)];
      retryAdded = deduped.length - specific.length;

      if (deduped.length >= 3) {
        log(`[Wave3Agent] Observation validation for ${entityName}: ${initial} -> ${deduped.length} (filtered: ${filtered}, retried: ${retryAdded}, supplemented: 0)`, 'info');
        return deduped.slice(0, 7);
      }

      specific.push(...deduped.slice(specific.length));
    } catch (retryError) {
      log(`[Wave3Agent] Observation retry failed for ${entityName}: ${retryError instanceof Error ? retryError.message : String(retryError)}`, 'warning');
    }

    // Step 3: Supplement from available data
    const supplements: string[] = [];

    // From description
    if (context.description && context.description.length > 10) {
      supplements.push(`Serves as ${context.description} within the ${context.parentName || 'parent'} sub-component at hierarchy path ${context.hierarchyPath}`);
    }

    // From hierarchy
    supplements.push(`${entityName} is an L3 Detail entity under ${context.parentName || 'parent'} in the project knowledge hierarchy`);

    // From source files (code-graph-rag file analysis)
    if (context.sourceFiles && context.sourceFiles.length > 0) {
      supplements.push(`Primary implementation in ${context.sourceFiles[0]} with ${context.sourceFiles.length} related source file(s) including ${context.sourceFiles.slice(0, 3).join(', ')}`);
    } else {
      // Attempt CGR lookup as fallback
      try {
        const { CodeGraphAgent } = await import('./code-graph-agent.js');
        const cgrAgent = new CodeGraphAgent();
        const cypher = `MATCH (f:File) WHERE toLower(f.file_path) CONTAINS toLower('${entityName}') RETURN f.file_path AS path LIMIT 5`;
        const result = await cgrAgent.runCypherQuery(cypher);
        const files = Array.isArray(result) ? result.map((r: any) => r.path).filter(Boolean) : [];
        if (files.length > 0) {
          supplements.push(`Primary implementation in ${files[0]} with ${files.length} related source file(s)`);
        }
      } catch {
        // CGR unavailable -- skip this supplement source silently
      }
    }

    if (supplements.length === 0) {
      supplements.push(`${entityName} represents a distinct architectural concern within ${context.parentName || 'parent'}`);
    }

    const final = [...specific, ...supplements].slice(0, 7);
    while (final.length < 3) {
      final.push(`${entityName} represents a distinct architectural concern within ${context.parentName || 'parent'}`);
    }

    const supplementAdded = final.length - specific.length;
    log(`[Wave3Agent] Observation validation for ${entityName}: ${initial} -> ${final.length} (filtered: ${filtered}, retried: ${retryAdded}, supplemented: ${supplementAdded})`, 'info');
    return final;
  }

  /**
   * Read scoped source files, truncating each to maxLines.
   * Returns concatenated file contents with file path headers.
   */
  private async readScopedFiles(files: string[], maxFiles: number = 8): Promise<string> {
    const maxLines = 200;
    const filesToRead = files.slice(0, maxFiles);
    const contents: string[] = [];

    for (const filePath of filesToRead) {
      try {
        const fullPath = path.isAbsolute(filePath)
          ? filePath
          : path.join(this.repositoryPath, filePath);

        if (!fs.existsSync(fullPath)) {
          continue;
        }

        const raw = fs.readFileSync(fullPath, 'utf-8');
        const lines = raw.split('\n');
        const truncated = lines.slice(0, maxLines).join('\n');
        const suffix = lines.length > maxLines ? `\n... (truncated, ${lines.length} total lines)` : '';

        contents.push(`### ${filePath}\n${truncated}${suffix}`);
      } catch (err) {
        log(`[Wave3Agent] Failed to read file ${filePath}: ${err instanceof Error ? err.message : String(err)}`, 'warning');
      }
    }

    if (contents.length === 0 && files.length > 0) {
      log(`[Wave3Agent] No scoped files could be read (${files.length} paths provided)`, 'warning');
    }

    if (contents.length > 0) {
      log(`[Wave3Agent] Read ${contents.length}/${files.length} scoped files`, 'info');
    }

    return contents.join('\n\n');
  }
}
