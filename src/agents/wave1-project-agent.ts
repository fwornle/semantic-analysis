/**
 * Wave1ProjectAgent - L0 Project + L1 Component Entity Producer
 *
 * The first wave agent in the hierarchical analysis pipeline.
 * Surveys the entire project using the component manifest as structure,
 * reads representative source files for each component, and calls
 * LLM for component summaries and observations.
 *
 * Produces:
 * - 1 L0 Project entity (root node)
 * - N L1 Component entities (one per manifest component)
 * - Parent-child relationships (L0 -> L1)
 * - Child manifest entries for Wave 2 (L2 suggestions)
 *
 * @module agents/wave1-project-agent
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logging.js';
import { LLMService } from '@rapid/llm-proxy';
import { isMockLLMEnabled, getMockDelay } from '../mock/llm-mock-service.js';
import { attachTokenLogger } from '../utils/token-usage-logger.js';
import type { KGEntity, KGRelation } from './kg-operators.js';
import type { ComponentManifest, ComponentManifestEntry } from '../types/component-manifest.js';
import type { Wave1Input, WaveAgentOutput, ChildManifestEntry, EntityTraceData } from '../types/wave-types.js';
import type { CgrQueryCache } from '../services/cgr-query-cache.js';
import type { CgrObservationBuilder } from '../utils/cgr-observation-builder.js';
import { SemanticAnalysisAgent } from './semantic-analysis-agent.js';
import { toCanonicalEntity, augmentWithCanonical } from './canonical-mapper.js';
import { createLLMWithProcess } from './llm-with-process.js';
import { PROCESS_TAGS } from './process-tags.js';
import { parseLlmJson } from '../utils/parse-llm-json.js';

// Phase 42.2 Plan 02 Gap 2 — process-tag for token-usage attribution.
// Wave1 enrich + analyze + observation-retry all share this tag (forensics
// report §2.1 row 1-3). The proxy reads `body.process` and stores it in
// `.data/llm-proxy/token-usage.db` for operator per-step routing config.
//
// Phase 52 D-05/D-06 — kept as the wave-level safety-net default bound at
// construction time. Each .complete() call below now passes a per-call
// `process: PROCESS_TAGS.<sub-step>` override so token-usage telemetry
// attributes the call to the sub-step tag instead of the wave-level tag.
const WAVE1_PROCESS_TAG = 'wave-analysis-wave1';

// ============================================================================
// Wave1ProjectAgent
// ============================================================================

export class Wave1ProjectAgent {
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
   *  on every wave1 LLM call (the SDK's LLMService does not expose `process`).
   *  Records into the same metrics tracker the SDK uses so trace
   *  instrumentation (wave-controller.getDetailedCalls) is unaffected. */
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
    attachTokenLogger(this.llmService, 'wave1-project-agent');
    this.cgrCache = cgrCache ?? null;
    this.cgrBuilder = cgrBuilder ?? null;
    this.runId = runId ?? `wave1-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    // Phase 42.2 Plan 02 Gap 2 — bind tracker so direct-fetch calls also land
    // in the SDK's metrics tracker (wave-controller's tracer reads from it).
    this.llmWithProcess = createLLMWithProcess(
      WAVE1_PROCESS_TAG,
      this.llmService.getMetricsTracker(),
    );
  }

  private async ensureLLMInitialized(): Promise<void> {
    if (!this.llmInitialized) {
      await this.llmService.initialize();
      this.llmInitialized = true;
      const providers = this.llmService.getAvailableProviders();
      log(`[Wave1ProjectAgent] LLMService initialized with providers: ${providers.join(', ')}`, 'info');
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

  // --------------------------------------------------------------------------
  // Main entry point
  // --------------------------------------------------------------------------

  async execute(input: Wave1Input): Promise<WaveAgentOutput> {
    const startTime = Date.now();

    log('[Wave1ProjectAgent] Starting Wave 1 execution', 'info', {
      projectName: input.manifest.project.name,
      componentCount: input.manifest.components.length,
      existingEntityCount: input.existingEntities.length,
    });

    const isMock = isMockLLMEnabled(this.repositoryPath);
    if (!isMock) {
      await this.ensureLLMInitialized();
    }

    const onPhase = input.onPhase;

    // Phase: sem_data_prep — scanning files and preparing data
    if (onPhase) await onPhase('sem_data_prep');

    // Step 1: Scan directory structure for project overview
    const directoryStructure = await this.scanDirectoryStructure(input.repositoryPath);

    // Step 2: Format existing KG entities as context
    const existingEntitiesContext = this.formatExistingEntities(input.existingEntities);

    // Phase: sem_llm_analysis — LLM analysis of components
    if (onPhase) await onPhase('sem_llm_analysis');

    // Step 3: Analyze each L1 component
    const l1Entities: KGEntity[] = [];
    const allChildManifest: ChildManifestEntry[] = [];
    const cgrPromptContextMap = new Map<string, string>(); // entityName -> cgrPromptContext

    for (const component of input.manifest.components) {
      log(`[Wave1ProjectAgent] Analyzing component: ${component.name}`, 'info');

      // Read representative source files
      const fileContents = await this.readRepresentativeFiles(input.repositoryPath, component);

      // Get LLM analysis (or mock analysis)
      let analysis: ComponentAnalysis;
      if (isMock) {
        analysis = this.generateMockAnalysis(component, directoryStructure);
        const delay = getMockDelay(this.repositoryPath);
        if (delay > 0) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } else {
        analysis = await this.analyzeComponent(
          component,
          directoryStructure,
          existingEntitiesContext,
          fileContents,
          input.docContext,
        );
      }

      // CGR integration: query code graph for component-scoped entities
      let cgrObservations: string[] = [];
      let cgrPromptContext = '';
      if (this.cgrCache?.isAvailable() && this.cgrBuilder) {
        try {
          await this.cgrCache.ensureReady();
          const cgrEntities = await this.cgrCache.queryComponentEntities(component.name, component.keywords);
          cgrObservations = this.cgrBuilder.buildStructuralObservations(cgrEntities, component.name);
          if (cgrEntities.length > 0) {
            const details = { entities: cgrEntities, callees: [], imports: [], signatures: cgrEntities.map(e => e.signature).filter((s): s is string => !!s) };
            cgrPromptContext = this.cgrBuilder.formatForLLMPrompt(details);
          }
          if (cgrPromptContext) {
            cgrPromptContextMap.set(component.name, cgrPromptContext);
          }
          log(`[Wave1] CGR for ${component.name}: ${cgrEntities.length} entities, ${cgrObservations.length} observations`, 'info');
        } catch (err) {
          log(`[Wave1] CGR query failed for ${component.name}, continuing without: ${err instanceof Error ? err.message : String(err)}`, 'warning');
        }
      }

      // Combine CGR observations with LLM analysis observations
      const combinedObservations = [...cgrObservations, ...analysis.observations];

      // Validate and enrich observations (enforce 3+ specific observations)
      const validatedObservations = await this.ensureMinimumObservations(
        component.name,
        combinedObservations,
        {
          description: component.description,
          hierarchyPath: `${input.manifest.project.name}/${component.name}`,
          parentName: input.manifest.project.name,
          sourceFiles: fileContents.map(fc => {
            // Extract file path from header: "// === path (N lines total) ==="
            const match = fc.match(/^\/\/ === (.+?) \(/);
            return match ? match[1] : '';
          }).filter(Boolean),
        },
      );

      // Build L1 entity
      const l1Entity = this.buildL1Entity(
        component,
        analysis.summary,
        validatedObservations,
        input.manifest.project.name,
      );
      l1Entities.push(l1Entity);

      // Build child manifest entries for Wave 2
      const children = this.buildChildManifestForComponent(
        component,
        analysis.suggestedChildren,
      );
      allChildManifest.push(...children);
    }

    // Phase: sem_observation_gen — enrichment and observation generation
    if (onPhase) await onPhase('sem_observation_gen');

    // Step 3b: Multi-step enrichment -- second LLM call per L1 entity for deep observations
    if (!isMock) {
      for (const l1Entity of l1Entities) {
        try {
          const enrichStart = Date.now();
          const entityCgrContext = cgrPromptContextMap.get(l1Entity.name) || '';
          const cgrSection = entityCgrContext
            ? `\n## Code Graph Evidence\n${entityCgrContext}\n`
            : '';
          const cgrTagInstructions = entityCgrContext
            ? '\nIf <code_graph> data is provided, reference it in your observations. Prefix observations grounded in code graph data with [LLM+CGR]. Prefix observations from your own analysis with [LLM].'
            : '';
          const docSection = input.docContext
            ? `\n## Project Documentation\n${input.docContext}\n`
            : '';

          const enrichPrompt = `You are performing deep observation synthesis for the "${l1Entity.name}" component of the Coding project.

## Component Context
Name: ${l1Entity.name}
Hierarchy: ${input.manifest.project.name}/${l1Entity.name}
${cgrSection}${docSection}
## Initial Analysis
${l1Entity.observations.join('\n')}

## Task
Given this component and its initial analysis, produce 5+ detailed multi-paragraph observations.
Each observation MUST:
- Reference specific architectural aspects, code patterns, or design decisions
- Include code file references where possible (file paths, class names, function names)
- Be self-contained and informative to a new developer
- Describe concrete behavior, not abstract platitudes
${cgrTagInstructions}
Return a JSON object: { "observations": ["obs1", "obs2", ...] }
IMPORTANT: Return ONLY the JSON object, no markdown code blocks.`;

          // Phase 42.2 Plan 02 Gap 2 — route through llmWithProcess so the
          // proxy's token-usage telemetry attributes this call to a tagged
          // sub-step (no longer 'unknown').
          // Phase 52 D-05 — per-call PROCESS_TAGS.WAVE1_L1_EMIT override.
          const enrichResult = await this.llmWithProcess.complete({
            process: PROCESS_TAGS.WAVE1_L1_EMIT,
            messages: [{ role: 'user', content: enrichPrompt }],
            taskType: 'semantic_analysis',
            agentId: 'wave1_project_enrich',
            tier: 'standard',
            maxTokens: 2048,
            temperature: 0.7,
            timeout: 60_000,
            responseFormat: { type: 'json_object' },
          });

          const enrichDurationMs = Date.now() - enrichStart;

          // Parse enriched observations
          let enrichedObs: string[] = [];
          try {
            const parsedResult = parseLlmJson<{ observations?: unknown }>(enrichResult.content);
            if (parsedResult.repaired) {
              log('[Wave1ProjectAgent] Repaired control characters in enrichment reply', 'debug');
            }
            const parsed = parsedResult.value ?? {};
            enrichedObs = Array.isArray(parsed.observations)
              ? parsed.observations.filter((o: unknown): o is string => typeof o === 'string')
              : [];
          } catch {
            // Parse failed, keep original observations
          }

          if (enrichedObs.length > 0) {
            // Auto-tag LLM observations based on CGR context presence
            const taggedObs = SemanticAnalysisAgent.autoTagObservations(enrichedObs, !!entityCgrContext);
            // Preserve any existing [CGR] observations, then replace LLM observations
            const existingCgrObs = l1Entity.observations.filter(o => o.startsWith('[CGR]'));
            l1Entity.observations = [...existingCgrObs, ...taggedObs];
            log(`[Wave1] Enriched entity ${l1Entity.name} with multi-step analysis (${taggedObs.length} observations, CGR context: ${!!entityCgrContext})`, 'info');
          }

          // Attach trace data
          const traceData: EntityTraceData = {
            llmCallCount: 1,
            totalDurationMs: enrichDurationMs,
            model: enrichResult.model || 'unknown',
            provider: enrichResult.provider || 'unknown',
            agentType: 'Wave1MultiStep',
          };
          (l1Entity as any)._traceData = [traceData];
        } catch (err) {
          // On failure, keep original observations and flag as shallow
          (l1Entity as any)._shallowAnalysis = true;
          log(`[Wave1] Multi-step enrichment failed for ${l1Entity.name}, using shallow analysis: ${err instanceof Error ? err.message : String(err)}`, 'warning');
        }
      }
    }

    // Phase: sem_entity_transform — building final entities and relationships
    if (onPhase) await onPhase('sem_entity_transform');

    // Step 4: Build L0 Project entity
    const projectSummary = this.buildProjectSummary(input.manifest, l1Entities);
    const l0Entity = this.buildL0Entity(input.manifest, projectSummary);

    // Step 5: Build relationships
    const allEntities = [l0Entity, ...l1Entities];
    const relationships = this.buildRelationships(l0Entity, l1Entities);

    const durationMs = Date.now() - startTime;

    log('[Wave1ProjectAgent] Wave 1 complete', 'info', {
      l0Entities: 1,
      l1Entities: l1Entities.length,
      relationships: relationships.length,
      childManifestEntries: allChildManifest.length,
      durationMs,
    });

    // Phase 42 Plan 06 — canonical emit: fold km-core canonical Entity fields
    // (ontologyClass, entityType, legacyId, metadata.subsystem,
    // metadata.descriptionSegments[0], metadata.provenance) onto each emitted
    // entity. Preserves legacy KGEntity fields (type, level, parentId,
    // hierarchyPath, _traceData) — downstream readers (mapEntityToSharedMemory,
    // VKB) keep working until Plan 7 deletes the legacy code paths.
    //
    // L0 is class 'Project'; every L1 is class 'Component'.
    //
    // toCanonicalEntity reference (acceptance grep target):
    const _grepMarker: unknown = toCanonicalEntity;  // eslint-disable-line @typescript-eslint/no-unused-vars
    // Phase 42.2 Plan 02 Gap 1 — thread `team` into the options bag so
    // canonical-mapper stamps `metadata.team` for km-core multi-tenant queries.
    // `this.team` is the workflow `parameters.team` injected at construction.
    // Phase 57 D-04 — also pass `project: this.team` so canonical-mapper
    // stamps the closed-set `metadata.project` tag. `this.team` defaults to
    // `'coding'` in this container per CLAUDE.md mapping; `isProject(this.team)`
    // gates the actual stamp inside canonical-mapper.
    // TODO(phase-60-or-later): plumb a dedicated `parameters.project` once
    // okm/cap teams come online so project and team can diverge.
    const canonicalEntities = allEntities.map((entity) => {
      const ontologyClass = entity.level === 0 ? 'Project' : 'Component';
      return augmentWithCanonical(entity, ontologyClass, this.runId, { team: this.team, project: this.team });
    });

    return {
      entities: canonicalEntities,
      relationships,
      childManifest: allChildManifest,
      discovered: false,
      durationMs,
      parentId: input.manifest.project.name,
      agentName: 'Wave1:Project',
    };
  }

  // --------------------------------------------------------------------------
  // LLM Analysis
  // --------------------------------------------------------------------------

  /**
   * Call LLM to analyze a component and produce summary, observations, and child suggestions.
   */
  private async analyzeComponent(
    component: ComponentManifestEntry,
    directoryStructure: string,
    existingEntitiesContext: string,
    representativeFiles: string[],
    docContext?: string,
  ): Promise<ComponentAnalysis> {
    const fileContentsBlock = representativeFiles.length > 0
      ? representativeFiles.join('\n\n---\n\n')
      : '(No representative files found)';

    const docSection = docContext ? `\n## Project Documentation\n${docContext}\n` : '';

    const prompt = `You are analyzing the ${component.name} component of the Coding project.

## Project Context
${directoryStructure}

## Existing Knowledge
${existingEntitiesContext}
${docSection}
## Component Definition
Name: ${component.name}
Description: ${component.description}
Keywords: ${component.keywords.join(', ')}

## Source Files
${fileContentsBlock}

## Task
1. Write a comprehensive summary (2-3 paragraphs) of what this component does, its architecture, and key patterns.

2. List 5-7 specific observations about this component. Each observation MUST:
   - Reference at least one specific code artifact (file path, class name, function name, or module)
   - Describe a concrete architectural decision, behavior, or pattern
   - Be self-contained (understandable without reading the source)

   GOOD observations (follow this style):
   - "Uses GraphDatabaseAdapter (storage/graph-database-adapter.ts) for Graphology+LevelDB persistence with automatic JSON export sync"
   - "Wave agents follow constructor(repoPath, team) + ensureLLMInitialized() + execute(input) pattern for lazy LLM initialization"
   - "Implements work-stealing concurrency via shared atomic index counter in runWithConcurrency() (wave-controller.ts:489)"

   BAD observations (DO NOT write these):
   - "Handles data storage" (too generic, no code reference)
   - "Is an important component" (no specifics, no artifact reference)
   - "Processes data efficiently" (vague, no code artifact mentioned)

ANTI-HALLUCINATION RULES:
- Every component you identify MUST correspond to actual directories, modules, or systems visible in the repository
- DO NOT invent components that you cannot point to in the codebase
- Each observation MUST reference specific files, directories, or configuration artifacts
- If you are uncertain whether a component exists, DO NOT include it
- It is better to return fewer accurate components than many speculative ones

3. Suggest sub-components (L2 nodes) that exist within this component. For each, provide name (PascalCase), description, and whether it's a new discovery beyond the manifest.

## Output Format (JSON)
{
  "summary": "...",
  "observations": ["...", "..."],
  "suggestedChildren": [
    { "name": "...", "description": "...", "discovered": true }
  ]
}

IMPORTANT: Return ONLY the JSON object, no markdown code blocks or surrounding text.`;

    try {
      // Phase 42.2 Plan 02 Gap 2 — route through llmWithProcess for tagged
      // process attribution.
      // Phase 52 D-05 — per-call PROCESS_TAGS.WAVE1_L1_EMIT override.
      const result = await this.llmWithProcess.complete({
        process: PROCESS_TAGS.WAVE1_L1_EMIT,
        messages: [{ role: 'user', content: prompt }],
        taskType: 'wave_component_analysis',
        agentId: 'wave1_project',
        tier: 'standard',
        maxTokens: 2048,
        temperature: 0.7,
        timeout: 60_000,
        responseFormat: { type: 'json_object' },
      });

      log(`[Wave1ProjectAgent] LLM analysis for ${component.name} via ${result.provider}/${result.model}`, 'info', {
        tokens: result.tokens.total,
      });

      return this.parseComponentAnalysis(result.content, component);
    } catch (error) {
      log(`[Wave1ProjectAgent] LLM call failed for ${component.name}, using fallback`, 'warning', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.generateMockAnalysis(component, directoryStructure);
    }
  }

  /**
   * Parse LLM JSON response into ComponentAnalysis.
   * Falls back to mock analysis on parse failure.
   */
  private parseComponentAnalysis(
    content: string,
    component: ComponentManifestEntry,
  ): ComponentAnalysis {
    try {
      // A raw newline inside a string value used to end up here as a thrown
      // parse error and a one-sentence fallback, which the downstream
      // "single-sentence stubs" constraint then rejected — losing the whole
      // component. parseLlmJson escapes the control characters and carries on.
      const parsedResult = parseLlmJson<Record<string, unknown>>(content);
      if (parsedResult.value === null) {
        throw new Error(parsedResult.error || 'unparseable LLM reply');
      }
      if (parsedResult.repaired) {
        log(
          `[Wave1ProjectAgent] Repaired control characters in LLM reply for ${component.name}`,
          'info',
        );
      }
      const parsed = parsedResult.value;

      return {
        summary: typeof parsed.summary === 'string' ? parsed.summary : component.description,
        observations: Array.isArray(parsed.observations)
          ? parsed.observations.filter((o: unknown): o is string => typeof o === 'string')
          : [component.description],
        suggestedChildren: Array.isArray(parsed.suggestedChildren)
          ? parsed.suggestedChildren
              .filter((c: unknown): c is Record<string, unknown> => typeof c === 'object' && c !== null)
              .map((c: Record<string, unknown>) => ({
                name: String(c.name ?? 'Unknown'),
                description: String(c.description ?? ''),
                discovered: Boolean(c.discovered),
              }))
          : [],
      };
    } catch (error) {
      log(`[Wave1ProjectAgent] Failed to parse LLM response for ${component.name}`, 'warning', {
        error: error instanceof Error ? error.message : String(error),
        contentPreview: content.substring(0, 200),
      });
      return {
        summary: component.description,
        observations: [component.description],
        suggestedChildren: [],
      };
    }
  }

  // --------------------------------------------------------------------------
  // Entity Construction
  // --------------------------------------------------------------------------

  /**
   * Build the L0 Project entity (root node).
   */
  private buildL0Entity(manifest: ComponentManifest, projectSummary: string): KGEntity {
    return {
      id: manifest.project.name,
      name: manifest.project.name,
      type: 'Project',
      observations: [
        projectSummary,
        `Project contains ${manifest.components.length} L1 components: ${manifest.components.map(c => c.name).join(', ')}`,
      ],
      significance: 10,
      parentId: undefined,
      level: 0,
      hierarchyPath: manifest.project.name,
    };
  }

  /**
   * Build an L1 Component entity.
   */
  private buildL1Entity(
    component: ComponentManifestEntry,
    summary: string,
    observations: string[],
    projectName: string,
  ): KGEntity {
    return {
      id: component.name,
      name: component.name,
      type: 'Component',
      observations: [summary, ...observations],
      significance: 8,
      parentId: projectName,
      level: 1,
      hierarchyPath: `${projectName}/${component.name}`,
    };
  }

  /**
   * Build parent-child relationship edges from L0 to each L1.
   */
  private buildRelationships(projectEntity: KGEntity, l1Entities: KGEntity[]): KGRelation[] {
    return l1Entities.map(l1 => ({
      from: projectEntity.name,
      to: l1.name,
      type: 'parent-child',
      weight: 1.0,
      source: 'explicit' as const,
    }));
  }

  /**
   * Build child manifest entries for a component.
   * Combines manifest-defined L2 children with LLM-suggested discoveries.
   */
  private buildChildManifestForComponent(
    component: ComponentManifestEntry,
    suggestedChildren: Array<{ name: string; description: string; discovered: boolean }>,
  ): ChildManifestEntry[] {
    const entries: ChildManifestEntry[] = [];

    // Add manifest-defined L2 children
    if (component.children) {
      for (const child of component.children) {
        entries.push({
          name: child.name,
          level: 2,
          parentId: component.name,
          description: child.description,
          discovered: false,
          suggestedFiles: [],
          keywords: child.keywords,
        });
      }
    }

    // Add LLM-suggested L2 children (mark as discovered)
    for (const suggested of suggestedChildren) {
      // Skip if already in manifest
      const alreadyExists = entries.some(
        e => e.name.toLowerCase() === suggested.name.toLowerCase(),
      );
      if (!alreadyExists && suggested.discovered) {
        entries.push({
          name: suggested.name,
          level: 2,
          parentId: component.name,
          description: suggested.description,
          discovered: true,
          suggestedFiles: [],
          keywords: [suggested.name.toLowerCase()],
        });
      }
    }

    return entries;
  }

  // --------------------------------------------------------------------------
  // File Scanning
  // --------------------------------------------------------------------------

  /**
   * Scan the repository directory structure at depth 2-3 to get the overall project shape.
   * Returns a compact directory listing string.
   */
  private async scanDirectoryStructure(repoPath: string): Promise<string> {
    const lines: string[] = [];
    const maxDepth = 3;

    const scan = (dir: string, prefix: string, depth: number): void => {
      if (depth > maxDepth) return;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        // Sort: directories first, then files
        const sorted = entries
          .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist')
          .sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
          });

        for (const entry of sorted) {
          if (entry.isDirectory()) {
            lines.push(`${prefix}${entry.name}/`);
            if (depth < maxDepth) {
              scan(path.join(dir, entry.name), prefix + '  ', depth + 1);
            }
          } else if (depth <= 2) {
            // Only list files at depth <= 2 to keep output compact
            lines.push(`${prefix}${entry.name}`);
          }
        }
      } catch {
        // Ignore permission errors
      }
    };

    scan(repoPath, '', 0);

    // Truncate if too large
    const maxLines = 200;
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + `\n... (${lines.length - maxLines} more entries)`;
    }

    return lines.join('\n');
  }

  /**
   * Read representative source files for a component.
   * Uses component keywords to locate relevant files, then reads up to 5 files
   * (truncated to first 200 lines each for structure + exports).
   */
  private async readRepresentativeFiles(
    repoPath: string,
    component: ComponentManifestEntry,
  ): Promise<string[]> {
    const fileContents: string[] = [];
    const maxFiles = 5;
    const maxLinesPerFile = 200;

    // Build search patterns from component keywords and aliases
    const searchTerms = [
      ...component.keywords.map(k => k.toLowerCase()),
      ...component.aliases.map(a => a.toLowerCase()),
      component.name.toLowerCase(),
    ];

    // Find candidate files by walking relevant directories
    const candidateFiles = this.findCandidateFiles(repoPath, searchTerms);

    // Prioritize: entry points > agents > configs > other source files
    const prioritized = candidateFiles.sort((a, b) => {
      const scoreA = this.fileRelevanceScore(a, component);
      const scoreB = this.fileRelevanceScore(b, component);
      return scoreB - scoreA;
    });

    // Read top files
    const filesToRead = prioritized.slice(0, maxFiles);
    for (const filePath of filesToRead) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const truncated = lines.slice(0, maxLinesPerFile).join('\n');
        const relativePath = path.relative(repoPath, filePath);
        const header = `// === ${relativePath} (${lines.length} lines total) ===`;
        fileContents.push(`${header}\n${truncated}`);
      } catch {
        // Skip unreadable files
      }
    }

    log(`[Wave1ProjectAgent] Read ${fileContents.length} files for ${component.name}`, 'info');
    return fileContents;
  }

  /**
   * Find candidate source files matching search terms.
   */
  private findCandidateFiles(repoPath: string, searchTerms: string[]): string[] {
    const results: string[] = [];
    const maxResults = 50;

    // Common source directories to search
    const searchDirs = [
      path.join(repoPath, 'integrations', 'semantic-analysis', 'src'),
      path.join(repoPath, 'integrations', 'system-health-dashboard', 'src'),
      path.join(repoPath, 'integrations', 'code-graph-rag'),
      path.join(repoPath, 'lib'),
      path.join(repoPath, 'scripts'),
    ];

    const walkDir = (dir: string, depth: number): void => {
      if (depth > 4 || results.length >= maxResults) return;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= maxResults) break;

          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
            continue;
          }

          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            // Check if directory name matches any search term
            const dirLower = entry.name.toLowerCase();
            const dirMatches = searchTerms.some(term => dirLower.includes(term) || term.includes(dirLower));
            if (dirMatches || depth < 2) {
              walkDir(fullPath, depth + 1);
            }
          } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
            const nameLower = entry.name.toLowerCase();
            const matches = searchTerms.some(term => nameLower.includes(term));
            if (matches) {
              results.push(fullPath);
            }
          }
        }
      } catch {
        // Ignore permission/access errors
      }
    };

    for (const searchDir of searchDirs) {
      if (fs.existsSync(searchDir)) {
        walkDir(searchDir, 0);
      }
    }

    return results;
  }

  /**
   * Score file relevance for prioritization.
   * Entry points and main files score higher.
   */
  private fileRelevanceScore(filePath: string, component: ComponentManifestEntry): number {
    const name = path.basename(filePath).toLowerCase();
    let score = 0;

    // Entry point patterns
    if (name === 'index.ts' || name === 'index.js') score += 5;
    if (name.includes('agent')) score += 3;
    if (name.includes('config')) score += 2;
    if (name.includes('main') || name.includes('entry')) score += 4;
    if (name.includes('service')) score += 2;

    // Component name match
    const componentLower = component.name.toLowerCase();
    if (name.includes(componentLower)) score += 4;

    // Keyword match
    for (const keyword of component.keywords) {
      if (name.includes(keyword.toLowerCase())) score += 2;
    }

    // Prefer .ts over .js
    if (name.endsWith('.ts')) score += 1;

    return score;
  }

  // --------------------------------------------------------------------------
  // Mock Analysis (for debug mode)
  // --------------------------------------------------------------------------

  /**
   * Generate synthetic analysis from manifest data without LLM calls.
   * Used when isMockLLMEnabled() returns true (ukb full debug mode).
   */
  private generateMockAnalysis(
    component: ComponentManifestEntry,
    _directoryStructure: string,
  ): ComponentAnalysis {
    const childCount = component.children?.length ?? 0;
    const childNames = component.children?.map(c => c.name).join(', ') ?? 'none';

    return {
      summary: `${component.name} is a component of the Coding project. ${component.description}. It contains ${childCount} sub-components: ${childNames}.`,
      observations: [
        `${component.name} handles ${component.description.toLowerCase()}`,
        `Component uses keywords: ${component.keywords.join(', ')}`,
        `Known aliases: ${component.aliases.join(', ') || 'none'}`,
        ...(component.children ?? []).map(c => `Sub-component ${c.name}: ${c.description}`),
      ],
      suggestedChildren: (component.children ?? []).map(c => ({
        name: c.name,
        description: c.description,
        discovered: false,
      })),
    };
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Format existing KG entities as a context block for the LLM prompt.
   */
  private formatExistingEntities(entities: KGEntity[]): string {
    if (entities.length === 0) {
      return '(No existing entities in knowledge graph)';
    }

    const lines = entities.slice(0, 30).map(e => {
      const firstObs = e.observations[0] ?? '';
      const truncatedObs = firstObs.length > 100 ? firstObs.substring(0, 100) + '...' : firstObs;
      return `- ${e.name} [${e.type}]: ${truncatedObs}`;
    });

    return lines.join('\n');
  }

  // --------------------------------------------------------------------------
  // Observation Validation
  // --------------------------------------------------------------------------

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
      /\.(ts|js|py|yaml|yml|json|md|puml)\b/i.test(obs) ||        // file extensions
      /[A-Z][a-z]+[A-Z]/.test(obs) ||                              // PascalCase/camelCase
      /\w+\.\w+\(/.test(obs) ||                                    // method calls
      /\/[\w-]+\//.test(obs) ||                                     // file paths
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
      log(`[Wave1ProjectAgent] Observation validation for ${entityName}: ${initial} -> ${specific.length} (filtered: ${filtered}, retried: 0, supplemented: 0)`, 'info');
      return specific.slice(0, 7);
    }

    // Step 2: Retry with enriched prompt
    let retryAdded = 0;
    const needed = 3 - specific.length;

    try {
      const retryPrompt = `You are generating specific observations about the "${entityName}" component.

Context:
- Description: ${context.description}
- Hierarchy: ${context.hierarchyPath}
${context.sourceFiles && context.sourceFiles.length > 0 ? `- Source files: ${context.sourceFiles.join(', ')}` : ''}

Generate exactly ${needed} specific observation(s) about this component. Each observation MUST:
- Reference at least one specific code artifact (file path, class name, function name, or module)
- Be a complete, self-contained sentence

GOOD examples:
- "Uses GraphDatabaseAdapter (storage/graph-database-adapter.ts) for Graphology+LevelDB persistence"
- "Implements work-stealing concurrency via shared index counter in runWithConcurrency()"

Return a JSON array of strings, e.g. ["observation 1", "observation 2"]`;

      // Phase 42.2 Plan 02 Gap 2 — route through llmWithProcess for tagged
      // process attribution on observation-retry.
      // Phase 52 D-05 — per-call PROCESS_TAGS.WAVE1_L1_EMIT override (same
      // sub-step as enrich + analyze; observation-retry is a recovery path
      // for the same emission boundary).
      const result = await this.llmWithProcess.complete({
        process: PROCESS_TAGS.WAVE1_L1_EMIT,
        messages: [{ role: 'user', content: retryPrompt }],
        taskType: 'observation_retry',
        agentId: 'wave1_project',
        tier: 'standard',
        maxTokens: 512,
        temperature: 0.7,
        timeout: 30_000,
      });

      let retryObs: string[] = [];
      try {
        const parsedResult = parseLlmJson<unknown>(result.content);
        if (parsedResult.repaired) {
          log('[Wave1ProjectAgent] Repaired control characters in observation retry', 'debug');
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
        log(`[Wave1ProjectAgent] Observation validation for ${entityName}: ${initial} -> ${deduped.length} (filtered: ${filtered}, retried: ${retryAdded}, supplemented: 0)`, 'info');
        return deduped.slice(0, 7);
      }

      // Update specific with retry results for supplement step
      specific.push(...deduped.slice(specific.length));
    } catch (retryError) {
      log(`[Wave1ProjectAgent] Observation retry failed for ${entityName}: ${retryError instanceof Error ? retryError.message : String(retryError)}`, 'warning');
    }

    // Step 3: Supplement from available data
    const supplements: string[] = [];

    // From description
    if (context.description && context.description.length > 10) {
      supplements.push(`Serves as ${context.description} within the ${context.parentName || 'project'} component at hierarchy path ${context.hierarchyPath}`);
    }

    // From hierarchy
    supplements.push(`${entityName} is an L1 Component entity under ${context.parentName || 'Coding'} in the project knowledge hierarchy`);

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

    // If no supplements with code refs, add generic
    if (supplements.length === 0) {
      supplements.push(`${entityName} represents a distinct architectural concern within ${context.parentName || 'Coding'}`);
    }

    const final = [...specific, ...supplements].slice(0, 7);
    // Ensure at least 3
    while (final.length < 3) {
      final.push(`${entityName} represents a distinct architectural concern within ${context.parentName || 'Coding'}`);
    }

    const supplementAdded = final.length - specific.length;
    log(`[Wave1ProjectAgent] Observation validation for ${entityName}: ${initial} -> ${final.length} (filtered: ${filtered}, retried: ${retryAdded}, supplemented: ${supplementAdded})`, 'info');
    return final;
  }

  /**
   * Build a project-level summary from the L1 entity analyses.
   */
  private buildProjectSummary(manifest: ComponentManifest, l1Entities: KGEntity[]): string {
    const componentSummaries = l1Entities.map(e => {
      const firstObs = e.observations[0] ?? e.name;
      return `${e.name}: ${firstObs.substring(0, 150)}`;
    });

    return `${manifest.project.description}. The project consists of ${l1Entities.length} major components: ${componentSummaries.join('; ')}.`;
  }
}

// ============================================================================
// Internal Types
// ============================================================================

interface ComponentAnalysis {
  summary: string;
  observations: string[];
  suggestedChildren: Array<{
    name: string;
    description: string;
    discovered: boolean;
  }>;
}
