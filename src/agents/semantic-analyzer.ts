import { log } from "../logging.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { isMockLLMEnabled, mockSemanticAnalysis, getLLMMode, type LLMMode } from "../mock/llm-mock-service.js";
import { LLMService } from "@rapid/llm-proxy";
import type { LLMCompletionResult, MockServiceInterface } from "@rapid/llm-proxy";
import { attachTokenLogger } from "../utils/token-usage-logger.js";
import { llmWithProcessComplete } from "./llm-with-process.js";

// ES module compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Debug logging function that writes to file (persists when stdio is discarded)
const SEMANTIC_DEBUG_LOG_PATH = path.join(process.cwd(), '.data', 'semantic-analyzer-debug.log');
function semanticDebugLog(message: string, data?: any): void {
  try {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}${data ? ' ' + JSON.stringify(data) : ''}\n`;
    fs.appendFileSync(SEMANTIC_DEBUG_LOG_PATH, logLine);
  } catch (e) {
    // Silently fail if we can't write to log
  }
}

// Model tier types
export type ModelTier = "fast" | "standard" | "premium";

// Task types that map to tiers
export type TaskType =
  | "git_history_analysis" | "vibe_history_analysis" | "semantic_code_analysis"
  | "documentation_linking" | "web_search_summarization" | "ontology_classification"
  | "content_validation" | "deduplication_similarity"
  | "insight_generation" | "observation_generation" | "pattern_recognition"
  | "quality_assurance_review" | "deep_code_analysis" | "entity_significance_scoring"
  | "git_file_extraction" | "commit_message_parsing" | "file_pattern_matching"
  | "basic_classification" | "documentation_file_scanning";

export interface AnalysisOptions {
  context?: string;
  analysisType?: "general" | "code" | "patterns" | "architecture" | "diagram" | "classification" | "raw" | "passthrough";
  provider?: "groq" | "gemini" | "anthropic" | "openai" | "ollama" | "custom" | "auto";
  tier?: ModelTier;
  taskType?: TaskType;
  /** Phase 42.2 Plan 06 follow-up — per-call timeout in milliseconds.
   *  Threaded into `llmService.complete()` so the underlying fetch aborts
   *  via AbortSignal.timeout when the proxy stalls. Without this, the
   *  insights wave hangs indefinitely on a stalled LLM call (no SDK
   *  default timeout). Mirrors the 60s default in `llm-with-process.ts`
   *  used by waves 1-3. */
  timeout?: number;
  /** Phase 52 D-09 — per-call process tag for token-usage attribution.
   *  When set, `analyzeContent` strangler-routes the call through
   *  `llmWithProcessComplete` (the direct-fetch wrapper that sets
   *  `body.process` on `/api/complete`) so the proxy stores the call
   *  under the sub-step tag instead of the default 'unknown' bucket.
   *  When undefined, the existing SDK direct path (`llmService.complete`)
   *  fires — preserves backward compatibility for orphan callers that
   *  haven't been migrated yet. Closes the deferred 42.2-06 wave-4
   *  InsightGenerationAgent unknown gap (the 5 insight-generation call
   *  sites + the single ontology-classification call site all set this
   *  field in Phase 52). */
  process?: string;
  /** Per-call output-token budget, forwarded to `/api/complete`.
   *
   *  Omitted, the proxy applies its own 4096 default — which on 2026-09-20
   *  cut 4 of 202 wave-4 diagram replies off mid-line at output_tokens
   *  EXACTLY 4096, sending a half-written PlantUML document to the repair
   *  path. The budget belongs to the caller because only the caller knows
   *  how long its document runs; this field is how it says so. */
  maxTokens?: number;
}

export interface CodeAnalysisOptions {
  language?: string;
  filePath?: string;
  focus?: "patterns" | "quality" | "security" | "performance" | "architecture";
}

export interface PatternExtractionOptions {
  patternTypes?: string[];
  context?: string;
}

export interface AnalysisResult {
  insights: string;
  provider: string;
  confidence: number;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  model?: string;
}

export interface CodeAnalysisResult {
  analysis: string;
  findings: string[];
  recommendations: string[];
  patterns: string[];
}

export interface Pattern {
  name: string;
  type: string;
  description: string;
  code: string;
  usageExample?: string;
}

export interface PatternExtractionResult {
  patterns: Pattern[];
  summary: string;
}

// Global LLM call metrics tracking (shared across all SemanticAnalyzer instances)
export interface LLMCallMetrics {
  provider: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  timestamp: number;
  promptPreview?: string;
  responsePreview?: string;
}

export interface StepLLMMetrics {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  providers: string[];
  calls: LLMCallMetrics[];
  intendedMode?: 'mock' | 'local' | 'public';
  actualMode?: 'mock' | 'local' | 'public';
  modeFallback?: boolean;
  fallbacks: Array<{
    timestamp: number;
    reason: string;
    failedProviders: string[];
    usedMethod: 'regex' | 'template' | 'none';
    taskType?: string;
  }>;
  fallbackCount: number;
}

export class SemanticAnalyzer {
  // Static repository path for mock mode checking
  private static repositoryPath: string = process.cwd();

  // Static current agent ID for per-agent LLM mode selection
  private static currentAgentId: string | null = null;

  static setRepositoryPath(path: string): void {
    SemanticAnalyzer.repositoryPath = path;
    log(`SemanticAnalyzer: repository path set to ${path}`, 'info');
  }

  static getRepositoryPath(): string {
    return SemanticAnalyzer.repositoryPath;
  }

  static setCurrentAgentId(agentId: string | null): void {
    SemanticAnalyzer.currentAgentId = agentId;
    log(`SemanticAnalyzer: current agent set to ${agentId}`, 'debug');
  }

  static getCurrentAgentId(): string | null {
    return SemanticAnalyzer.currentAgentId;
  }

  static getLLMModeForAgent(agentId?: string): LLMMode {
    const effectiveAgentId = agentId || SemanticAnalyzer.currentAgentId;
    return getLLMMode(SemanticAnalyzer.repositoryPath, effectiveAgentId || undefined);
  }

  // Static metrics tracking for workflow step aggregation
  private static currentStepMetrics: StepLLMMetrics = {
    totalCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    providers: [],
    calls: [],
    fallbacks: [],
    fallbackCount: 0,
  };

  static resetStepMetrics(): void {
    const intendedMode = SemanticAnalyzer.getLLMModeForAgent();
    SemanticAnalyzer.currentStepMetrics = {
      totalCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      providers: [],
      calls: [],
      intendedMode,
      actualMode: undefined,
      modeFallback: false,
      fallbacks: [],
      fallbackCount: 0,
    };
  }

  private static recordActualMode(mode: 'mock' | 'local' | 'public'): void {
    if (!SemanticAnalyzer.currentStepMetrics.actualMode) {
      SemanticAnalyzer.currentStepMetrics.actualMode = mode;
      if (SemanticAnalyzer.currentStepMetrics.intendedMode &&
          SemanticAnalyzer.currentStepMetrics.intendedMode !== mode) {
        SemanticAnalyzer.currentStepMetrics.modeFallback = true;
        log(`LLM mode fallback: intended=${SemanticAnalyzer.currentStepMetrics.intendedMode}, actual=${mode}`, 'warning');
      }
    }
  }

  static recordFallback(options: {
    reason: string;
    failedProviders: string[];
    usedMethod: 'regex' | 'template' | 'none';
    taskType?: string;
  }): void {
    SemanticAnalyzer.currentStepMetrics.fallbacks.push({
      timestamp: Date.now(),
      ...options,
    });
    SemanticAnalyzer.currentStepMetrics.fallbackCount++;
    log(`LLM fallback recorded: ${options.reason} → ${options.usedMethod}`, 'warning', {
      failedProviders: options.failedProviders,
      taskType: options.taskType,
    });
  }

  static getStepMetrics(): StepLLMMetrics {
    return { ...SemanticAnalyzer.currentStepMetrics };
  }

  private static recordCallMetrics(result: AnalysisResult, promptPreview?: string, responsePreview?: string): void {
    if (result.tokenUsage) {
      const metrics: LLMCallMetrics = {
        provider: result.provider,
        model: result.model,
        inputTokens: result.tokenUsage.inputTokens,
        outputTokens: result.tokenUsage.outputTokens,
        totalTokens: result.tokenUsage.totalTokens,
        timestamp: Date.now(),
        promptPreview,
        responsePreview,
      };

      SemanticAnalyzer.currentStepMetrics.calls.push(metrics);
      SemanticAnalyzer.currentStepMetrics.totalCalls++;
      SemanticAnalyzer.currentStepMetrics.totalInputTokens += metrics.inputTokens;
      SemanticAnalyzer.currentStepMetrics.totalOutputTokens += metrics.outputTokens;
      SemanticAnalyzer.currentStepMetrics.totalTokens += metrics.totalTokens;

      if (!SemanticAnalyzer.currentStepMetrics.providers.includes(result.provider)) {
        SemanticAnalyzer.currentStepMetrics.providers.push(result.provider);
      }
    }
  }

  static recordMetricsFromExternal(metrics: {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }): void {
    const callMetrics: LLMCallMetrics = {
      ...metrics,
      timestamp: Date.now(),
    };

    SemanticAnalyzer.currentStepMetrics.calls.push(callMetrics);
    SemanticAnalyzer.currentStepMetrics.totalCalls++;
    SemanticAnalyzer.currentStepMetrics.totalInputTokens += metrics.inputTokens;
    SemanticAnalyzer.currentStepMetrics.totalOutputTokens += metrics.outputTokens;
    SemanticAnalyzer.currentStepMetrics.totalTokens += metrics.totalTokens;

    if (!SemanticAnalyzer.currentStepMetrics.providers.includes(metrics.provider)) {
      SemanticAnalyzer.currentStepMetrics.providers.push(metrics.provider);
    }

    log(`Recorded external LLM call: ${metrics.provider}/${metrics.model} - ${metrics.totalTokens} tokens`, 'debug');
  }

  // LLM Service instance
  private llmService: LLMService;
  private llmInitialized = false;

  // PERFORMANCE OPTIMIZATION: Request batching
  private batchQueue: Array<{
    prompt: string;
    options: AnalysisOptions;
    resolve: (result: AnalysisResult) => void;
    reject: (error: any) => void;
  }> = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly BATCH_SIZE = Math.min(Math.max(
    parseInt(process.env.LLM_BATCH_SIZE || '20', 10), 1
  ), 50);
  private readonly BATCH_TIMEOUT = 100; // ms

  constructor() {
    // Create LLM service with mode resolver and mock service wiring
    this.llmService = new LLMService();
    // Phase 42 Plan 07 — Surprise #5 fix: CommonJS require() → static ESM import
    // (pre-existing ESM regression from commit 12fc1f5, predates Phase 42).
    attachTokenLogger(this.llmService, 'semantic-analyzer');

    // Wire mode resolver: delegates to static getLLMModeForAgent()
    this.llmService.setModeResolver((agentId) =>
      SemanticAnalyzer.getLLMModeForAgent(agentId || undefined)
    );

    // Wire mock service: delegates to existing mockSemanticAnalysis()
    this.llmService.setMockService({
      mockLLMCall: async (agentType: string, prompt: string, repositoryPath: string): Promise<LLMCompletionResult> => {
        const mockResult = await mockSemanticAnalysis(prompt, repositoryPath);
        return {
          content: mockResult.content,
          provider: 'mock',
          model: 'mock-llm-v1',
          tokens: {
            input: mockResult.tokenUsage.inputTokens,
            output: mockResult.tokenUsage.outputTokens,
            total: mockResult.tokenUsage.totalTokens,
          },
          mock: true,
          local: true,
        };
      },
    });

    this.llmService.setRepositoryPath(SemanticAnalyzer.repositoryPath);

    semanticDebugLog('SemanticAnalyzer constructed with LLMService');
  }

  /**
   * Ensure LLM service is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.llmInitialized) {
      await this.llmService.initialize();
      this.llmInitialized = true;
      semanticDebugLog('LLMService initialized', {
        providers: this.llmService.getAvailableProviders(),
      });
    }
  }

  /**
   * Convert LLMCompletionResult to AnalysisResult format
   */
  private toAnalysisResult(result: LLMCompletionResult): AnalysisResult {
    // Determine confidence based on provider
    let confidence = 0.85;
    if (result.provider === 'anthropic') confidence = 0.9;
    if (result.provider === 'gemini') confidence = 0.88;
    if (result.provider === 'openai') confidence = 0.85;
    if (result.provider === 'dmr' || result.provider === 'ollama') confidence = 0.80;
    if (result.provider === 'mock') confidence = 0.85;

    // Record actual mode
    if (result.mock) {
      SemanticAnalyzer.recordActualMode('mock');
    } else if (result.local) {
      SemanticAnalyzer.recordActualMode('local');
    } else {
      SemanticAnalyzer.recordActualMode('public');
    }

    return {
      insights: result.content,
      provider: result.provider,
      confidence,
      model: result.model,
      tokenUsage: {
        inputTokens: result.tokens.input,
        outputTokens: result.tokens.output,
        totalTokens: result.tokens.total,
      },
    };
  }

  /**
   * Determine tier from task type (public method used by external agents)
   */
  getTierForTask(taskType?: TaskType): ModelTier {
    if (!taskType) return 'standard';

    // Check environment variable override first
    const envTier = process.env.SEMANTIC_ANALYSIS_TIER?.toLowerCase() as ModelTier;
    if (envTier && ['fast', 'standard', 'premium'].includes(envTier)) {
      return envTier;
    }

    // Delegate to LLM service registry
    return this.llmService.getTierForTask(taskType) || 'standard';
  }

  // --- Core Analysis Methods ---

  async analyzeContent(content: string, options: AnalysisOptions = {}): Promise<AnalysisResult> {
    const { context, analysisType = "general", tier, taskType, timeout, maxTokens, process: processTag } = options;

    await this.ensureInitialized();

    const llmMode = SemanticAnalyzer.getLLMModeForAgent();
    log(`[LLM-MODE] mode=${llmMode}, agentId=${SemanticAnalyzer.currentAgentId}`, 'info');

    const prompt = this.buildAnalysisPrompt(content, context, analysisType);

    // Determine effective tier
    const effectiveTier = tier || this.getTierForTask(taskType as TaskType) || 'standard';

    log(`Analyzing content, tier: ${effectiveTier}`, "info", {
      contentLength: content.length,
      analysisType,
      tier: effectiveTier,
      taskType,
    });

    // Phase 52 D-09 strangler swap — when the caller supplies a `process`
    // tag, route through llmWithProcessComplete (the direct-fetch wrapper
    // that sets body.process on /api/complete) so token-usage telemetry
    // attributes the call to a named sub-step instead of the default
    // 'unknown' bucket. The SDK's MetricsTracker is passed through so
    // wave-controller.getDetailedCalls() / getLLMMetrics() consumers
    // (lines 622, 645, 812, 992, 1762) keep seeing every call uniformly.
    // SDK direct path (below) is preserved as fallback for orphan callers
    // not yet migrated.
    //
    // IMPORTANT: the strangler MUST fire BEFORE the batching short-circuit
    // below, otherwise diagram/pattern calls (analysisType === 'diagram'
    // or 'patterns') route to `analyzeContentDirectly` which does NOT read
    // `options.process` and falls through to `llmService.complete()`,
    // landing in token_usage.db as `process='unknown'`. Phase 52 Task 5
    // acceptance-gate failure (27 unknown rows from wave-4 diagram path)
    // diagnosed this ordering bug.
    if (typeof processTag === 'string' && processTag.length > 0) {
      try {
        const proxyResult = await llmWithProcessComplete(
          {
            process: processTag,
            messages: [{ role: 'user', content: prompt }],
            tier: effectiveTier,
            ...(typeof taskType === 'string' ? { taskType } : {}),
            ...(SemanticAnalyzer.currentAgentId ? { agentId: SemanticAnalyzer.currentAgentId } : {}),
            ...(typeof timeout === 'number' ? { timeout } : {}),
            // Forwarded, not defaulted: an omitted budget must keep meaning
            // "whatever the proxy decides", which is what every unmigrated
            // caller already relies on.
            ...(typeof maxTokens === 'number' ? { maxTokens } : {}),
          },
          this.llmService.getMetricsTracker(),
        );

        // Normalize the wrapper's response into the SDK's LLMCompletionResult
        // shape so toAnalysisResult() works unchanged. The wrapper's tokens
        // field already matches the SDK's {total, input?, output?} structure.
        const completionShape: LLMCompletionResult = {
          content: proxyResult.content,
          model: proxyResult.model,
          provider: proxyResult.provider,
          tokens: {
            total: proxyResult.tokens.total,
            input: proxyResult.tokens.input ?? 0,
            output: proxyResult.tokens.output ?? 0,
          },
          // The proxy fetch path is by definition not the SDK's mock or local
          // path — wave-analysis production traffic only. recordActualMode
          // will mark this as 'public' inside toAnalysisResult.
        } as LLMCompletionResult;

        const analysisResult = this.toAnalysisResult(completionShape);
        SemanticAnalyzer.recordCallMetrics(analysisResult, prompt?.slice(0, 500), proxyResult.content?.slice(0, 500));
        return analysisResult;
      } catch (error: any) {
        log('All LLM providers failed', 'error', { error: error?.message ?? String(error) });
        throw new Error(`All LLM providers failed. Errors: ${error?.message ?? String(error)}`);
      }
    }

    // PERFORMANCE OPTIMIZATION: Use batching for non-urgent requests.
    // Reached only when no process tag is supplied — process-tagged calls
    // were strangler-routed above to preserve sub-step token attribution
    // (Phase 52 Task 5 acceptance-gate fix).
    const shouldBatch = analysisType === "diagram" || analysisType === "patterns";

    if (shouldBatch) {
      return new Promise<AnalysisResult>((resolve, reject) => {
        this.batchQueue.push({ prompt, options, resolve, reject });

        if (this.batchQueue.length >= this.BATCH_SIZE) {
          if (this.batchTimer) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
          }
          this.processBatch();
        } else {
          this.scheduleBatch();
        }
      });
    }

    // Single request: delegate to LLM service
    try {
      const result = await this.llmService.complete({
        messages: [{ role: 'user', content: prompt }],
        tier: effectiveTier,
        taskType: taskType,
        agentId: SemanticAnalyzer.currentAgentId || undefined,
        // Phase 42.2 Plan 06 follow-up — forward caller-supplied timeout so a
        // stalled proxy connection aborts via AbortSignal.timeout instead of
        // hanging the wave forever (Wave 4 insights regression root cause).
        ...(typeof timeout === 'number' ? { timeout } : {}),
      });

      const analysisResult = this.toAnalysisResult(result);

      // Record metrics for step-level aggregation
      SemanticAnalyzer.recordCallMetrics(analysisResult, prompt?.slice(0, 500), result.content?.slice(0, 500));

      return analysisResult;
    } catch (error: any) {
      log('All LLM providers failed', 'error', { error: error.message });
      throw new Error(`All LLM providers failed. Errors: ${error.message}`);
    }
  }

  async analyzeCode(code: string, options: CodeAnalysisOptions = {}): Promise<CodeAnalysisResult> {
    const { language, filePath, focus = "patterns" } = options;

    log(`Analyzing code with focus: ${focus}`, "info", {
      codeLength: code.length,
      language,
      filePath,
    });

    const prompt = this.buildCodeAnalysisPrompt(code, language, filePath, focus);
    const result = await this.analyzeContent(prompt, {
      analysisType: "code",
    });

    return this.parseCodeAnalysisResult(result.insights);
  }

  async extractPatterns(source: string, options: PatternExtractionOptions = {}): Promise<PatternExtractionResult> {
    const { patternTypes = ["design", "architectural", "workflow"], context } = options;

    log("Extracting patterns from source", "info", {
      sourceLength: source.length,
      patternTypes,
      hasContext: !!context,
    });

    const prompt = this.buildPatternExtractionPrompt(source, patternTypes, context);
    const result = await this.analyzeContent(prompt, {
      analysisType: "patterns",
    });

    return this.parsePatternExtractionResult(result.insights);
  }

  // --- Batch Processing ---

  private async processBatch(): Promise<void> {
    if (this.batchQueue.length === 0) return;

    const currentBatch = this.batchQueue.splice(0, this.BATCH_SIZE);
    log(`Processing batch of ${currentBatch.length} requests`, 'info');

    try {
      const batchPromises = currentBatch.map(async (item) => {
        try {
          const result = await this.analyzeContentDirectly(item.prompt, item.options);
          item.resolve(result);
        } catch (error) {
          item.reject(error);
        }
      });

      await Promise.all(batchPromises);
      log(`Completed batch processing of ${currentBatch.length} requests`, 'info');
    } catch (error) {
      log(`Batch processing failed`, 'error', error);
      currentBatch.forEach(item => item.reject(error));
    }

    if (this.batchQueue.length > 0) {
      this.scheduleBatch();
    }
  }

  private scheduleBatch(): void {
    if (this.batchTimer) return;

    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.processBatch();
    }, this.BATCH_TIMEOUT);
  }

  private async analyzeContentDirectly(content: string, options: AnalysisOptions = {}): Promise<AnalysisResult> {
    await this.ensureInitialized();

    const { context, analysisType = "general" } = options;
    const prompt = this.buildAnalysisPrompt(content, context, analysisType);

    const result = await this.llmService.complete({
      messages: [{ role: 'user', content: prompt }],
      agentId: SemanticAnalyzer.currentAgentId || undefined,
    });

    const analysisResult = this.toAnalysisResult(result);
    SemanticAnalyzer.recordCallMetrics(analysisResult, prompt?.slice(0, 500), result.content?.slice(0, 500));
    return analysisResult;
  }

  // --- Prompt Building ---

  private buildAnalysisPrompt(content: string, context?: string, analysisType: string = "general"): string {
    let prompt = "";

    switch (analysisType) {
      case "patterns":
        prompt = `Analyze the following content for architectural and design patterns. Identify recurring patterns, best practices, and reusable solutions.

${context ? `Context: ${context}\n\n` : ""}

Content to analyze:
${content}

Please provide:
1. List of identified patterns with clear names
2. Description of each pattern
3. Significance score (1-10)
4. Implementation details
5. Usage recommendations`;
        break;

      case "code":
        prompt = `Analyze the following code for quality, patterns, and improvements.

${context ? `Context: ${context}\n\n` : ""}

Code to analyze:
${content}

Please provide:
1. Code quality assessment
2. Identified patterns and anti-patterns
3. Security considerations
4. Performance insights
5. Improvement recommendations`;
        break;

      case "architecture":
        prompt = `Analyze the following for architectural insights and design decisions.

${context ? `Context: ${context}\n\n` : ""}

Content:
${content}

Please provide:
1. Architectural patterns identified
2. Design decisions and trade-offs
3. System structure insights
4. Scalability considerations
5. Maintainability assessment`;
        break;

      case "diagram":
        prompt = `Generate a PlantUML diagram based on the following analysis data.

${context ? `Context: ${context}\n\n` : ""}

Analysis Data:
${content}

IMPORTANT REQUIREMENTS:
- You MUST respond with a complete PlantUML diagram enclosed in @startuml and @enduml tags
- Use proper PlantUML syntax for the requested diagram type
- Make the diagram visually clear and informative with real components from the analysis
- Include meaningful relationships and annotations based on the actual data
- Do NOT provide explanatory text - ONLY the PlantUML code
- The diagram should represent the actual architectural patterns and components found in the analysis

Generate the PlantUML diagram now:`;
        break;

      case "raw":
      case "passthrough":
      case "classification":
        prompt = context ? `${context}\n\n${content}` : content;
        break;

      default:
        prompt = `Provide a comprehensive analysis of the following content.

${context ? `Context: ${context}\n\n` : ""}

Content:
${content}

Please provide detailed insights, patterns, and recommendations.`;
    }

    return prompt;
  }

  private buildCodeAnalysisPrompt(code: string, language?: string, filePath?: string, focus: string = "patterns"): string {
    return `Analyze the following ${language || "code"} for ${focus}.
${filePath ? `File: ${filePath}\n` : ""}

Code:
${code}

Focus on ${focus} analysis and provide:
1. Main findings
2. Specific patterns or issues
3. Recommendations
4. Code examples where relevant`;
  }

  private buildPatternExtractionPrompt(source: string, patternTypes: string[], context?: string): string {
    return `Extract ${patternTypes.join(", ")} patterns from the following source.
${context ? `Context: ${context}\n` : ""}

Source:
${source}

For each pattern found, provide:
1. Pattern name (PascalCase)
2. Pattern type
3. Clear description
4. Code example
5. Usage recommendations`;
  }

  // --- Result Parsing ---

  private parseCodeAnalysisResult(insights: string): CodeAnalysisResult {
    const lines = insights.split("\n");
    const findings: string[] = [];
    const recommendations: string[] = [];
    const patterns: string[] = [];

    let currentSection = "";
    for (const line of lines) {
      if (line.includes("finding") || line.includes("issue")) {
        currentSection = "findings";
      } else if (line.includes("recommend") || line.includes("suggestion")) {
        currentSection = "recommendations";
      } else if (line.includes("pattern")) {
        currentSection = "patterns";
      } else if (line.trim() && currentSection) {
        switch (currentSection) {
          case "findings": findings.push(line.trim()); break;
          case "recommendations": recommendations.push(line.trim()); break;
          case "patterns": patterns.push(line.trim()); break;
        }
      }
    }

    return { analysis: insights, findings, recommendations, patterns };
  }

  private parsePatternExtractionResult(insights: string): PatternExtractionResult {
    const patterns: Pattern[] = [];
    const lines = insights.split("\n");

    let currentPattern: Partial<Pattern> | null = null;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.match(/^(Pattern|Name):\s*(.+)/i)) {
        if (currentPattern?.name) {
          patterns.push(this.finalizePattern(currentPattern));
        }
        currentPattern = { name: RegExp.$2.trim() };
      } else if (currentPattern) {
        if (trimmed.match(/^Type:\s*(.+)/i)) {
          currentPattern.type = RegExp.$1.trim();
        } else if (trimmed.match(/^Description:\s*(.+)/i)) {
          currentPattern.description = RegExp.$1.trim();
        } else if (trimmed.match(/^Code:|Example:/i)) {
          currentPattern.code = "";
        } else if (currentPattern.code !== undefined && trimmed) {
          currentPattern.code += trimmed + "\n";
        }
      }
    }

    if (currentPattern?.name) {
      patterns.push(this.finalizePattern(currentPattern));
    }

    return {
      patterns,
      summary: `Extracted ${patterns.length} patterns from analysis`,
    };
  }

  private finalizePattern(partial: Partial<Pattern>): Pattern {
    return {
      name: partial.name || "UnnamedPattern",
      type: partial.type || "general",
      description: partial.description || "Pattern extracted from analysis",
      code: partial.code || "",
      usageExample: partial.usageExample,
    };
  }

  // --- Utility Methods ---

  async generateEmbedding(text: string): Promise<number[]> {
    log("Generating embedding for text", "info", { textLength: text.length });
    const results = await this.generateEmbeddings([text]);
    return results[0] || [];
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    try {
      const scriptPath = path.join(__dirname, '../../src/utils/embedding_generator.py');
      const pythonPath = process.env.EMBEDDING_PYTHON || path.join(__dirname, '../../.embedding-venv/bin/python3');
      const inputData = JSON.stringify(texts);

      const result = await new Promise<string>((resolve, reject) => {
        const proc = spawn(pythonPath, [scriptPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 120000,
        });

        let stdout = '';
        let stderr = '';
        let stdoutSize = 0;
        const maxBuffer = 50 * 1024 * 1024;

        proc.stdout.on('data', (chunk: Buffer) => {
          stdoutSize += chunk.length;
          if (stdoutSize > maxBuffer) {
            proc.kill();
            reject(new Error('maxBuffer exceeded'));
            return;
          }
          stdout += chunk.toString();
        });

        proc.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        proc.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`Python process exited with code ${code}: ${stderr}`));
          } else {
            resolve(stdout);
          }
        });

        proc.on('error', (err) => {
          reject(err);
        });

        proc.stdin.write(inputData);
        proc.stdin.end();
      });

      const parsed = JSON.parse(result);
      if (!Array.isArray(parsed) || parsed.length !== texts.length) {
        log('Embedding generator returned unexpected result', 'warning', {
          expected: texts.length,
          got: Array.isArray(parsed) ? parsed.length : typeof parsed,
        });
        return texts.map(() => []);
      }

      log('Batch embeddings generated', 'info', {
        count: texts.length,
        dimensions: parsed[0]?.length || 0,
      });

      return parsed;
    } catch (error) {
      log('Failed to generate embeddings via Python subprocess', 'warning', {
        error: error instanceof Error ? error.message : String(error),
        textCount: texts.length,
      });
      return texts.map(() => []);
    }
  }

  async analyzeDifferences(content1: string, content2: string): Promise<{ hasUniqueValue: boolean; differences: string[] }> {
    const prompt = `Compare these two pieces of content and identify unique valuable differences:

Content 1:
${content1}

Content 2:
${content2}

Identify:
1. Unique insights in Content 1 not present in Content 2
2. Whether Content 1 adds meaningful new information
3. Key differences between the contents`;

    const result = await this.analyzeContent(prompt, { analysisType: "general" });

    const hasUniqueValue = result.insights.toLowerCase().includes("unique") ||
                          result.insights.toLowerCase().includes("new information");

    return { hasUniqueValue, differences: [result.insights] };
  }

  // ============================================================================
  // MULTI-AGENT SYSTEM: AgentResponse Envelope Methods
  // ============================================================================

  async analyzeContentWithEnvelope(
    content: string,
    options: AnalysisOptions & {
      stepName?: string;
      upstreamConfidence?: number;
      upstreamIssues?: Array<{ severity: string; message: string }>;
    } = {}
  ): Promise<{
    data: AnalysisResult;
    metadata: {
      confidence: number;
      confidenceBreakdown: {
        dataCompleteness: number;
        semanticCoherence: number;
        upstreamInfluence: number;
        processingQuality: number;
      };
      qualityScore: number;
      issues: Array<{
        severity: 'critical' | 'warning' | 'info';
        category: string;
        code: string;
        message: string;
        retryable: boolean;
        suggestedFix?: string;
      }>;
      warnings: string[];
      processingTimeMs: number;
      modelUsed?: string;
      tokenUsage?: { input: number; output: number; total: number };
    };
    routing: {
      suggestedNextSteps: string[];
      skipRecommendations: string[];
      escalationNeeded: boolean;
      escalationReason?: string;
      retryRecommendation?: {
        shouldRetry: boolean;
        reason: string;
        suggestedChanges: string;
      };
    };
    timestamp: string;
    agentId: string;
    stepName: string;
  }> {
    const startTime = Date.now();
    const issues: Array<{
      severity: 'critical' | 'warning' | 'info';
      category: string;
      code: string;
      message: string;
      retryable: boolean;
      suggestedFix?: string;
    }> = [];
    const warnings: string[] = [];
    let modelUsed: string | undefined;

    try {
      const inputValidation = this.validateInput(content, options);
      if (!inputValidation.valid) {
        issues.push({
          severity: 'warning',
          category: 'data_quality',
          code: 'INPUT_VALIDATION_WARNING',
          message: inputValidation.message || 'Input validation issue',
          retryable: false,
        });
      }

      if (options.upstreamConfidence !== undefined && options.upstreamConfidence < 0.5) {
        warnings.push(`Upstream confidence is low (${options.upstreamConfidence.toFixed(2)}), results may be affected`);
      }

      const result = await this.analyzeContent(content, options);
      modelUsed = result.provider;

      const confidenceBreakdown = this.calculateSemanticConfidence(content, result, options);
      const overallConfidence = this.computeOverallConfidence(confidenceBreakdown);

      const resultIssues = this.detectResultIssues(result, confidenceBreakdown);
      issues.push(...resultIssues);

      const routing = this.generateRoutingSuggestions(overallConfidence, issues, options);

      const processingTimeMs = Date.now() - startTime;

      return {
        data: result,
        metadata: {
          confidence: overallConfidence,
          confidenceBreakdown,
          qualityScore: Math.round(overallConfidence * 100),
          issues,
          warnings,
          processingTimeMs,
          modelUsed,
        },
        routing,
        timestamp: new Date().toISOString(),
        agentId: 'semantic_analyzer',
        stepName: options.stepName || 'semantic_analysis',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const processingTimeMs = Date.now() - startTime;

      issues.push({
        severity: 'critical',
        category: 'processing_error',
        code: 'SEMANTIC_ANALYSIS_FAILED',
        message: `Analysis failed: ${errorMessage}`,
        retryable: true,
        suggestedFix: 'Retry with smaller content or different provider',
      });

      return {
        data: { insights: '', provider: 'error', confidence: 0 },
        metadata: {
          confidence: 0,
          confidenceBreakdown: {
            dataCompleteness: 0,
            semanticCoherence: 0,
            upstreamInfluence: options.upstreamConfidence ?? 1,
            processingQuality: 0,
          },
          qualityScore: 0,
          issues,
          warnings,
          processingTimeMs,
        },
        routing: {
          suggestedNextSteps: [],
          skipRecommendations: [],
          escalationNeeded: false,
          retryRecommendation: {
            shouldRetry: true,
            reason: 'Analysis failed due to error',
            suggestedChanges: 'Check content length and format, retry with different parameters',
          },
        },
        timestamp: new Date().toISOString(),
        agentId: 'semantic_analyzer',
        stepName: options.stepName || 'semantic_analysis',
      };
    }
  }

  private validateInput(content: string, options: AnalysisOptions): { valid: boolean; message?: string } {
    if (!content || content.trim().length === 0) {
      return { valid: false, message: 'Content is empty' };
    }
    if (content.length > 100000) {
      return { valid: false, message: 'Content exceeds maximum length (100KB)' };
    }
    if (content.length < 10) {
      return { valid: false, message: 'Content is too short for meaningful analysis' };
    }
    return { valid: true };
  }

  private calculateSemanticConfidence(
    content: string,
    result: AnalysisResult,
    options: AnalysisOptions & { upstreamConfidence?: number }
  ): {
    dataCompleteness: number;
    semanticCoherence: number;
    upstreamInfluence: number;
    processingQuality: number;
  } {
    let dataCompleteness = 0.8;
    if (content.length > 1000) dataCompleteness = 0.9;
    if (content.length > 5000) dataCompleteness = 1.0;
    if (content.length < 100) dataCompleteness = 0.5;

    let semanticCoherence = result.confidence;
    if (result.insights.length < 50) semanticCoherence *= 0.7;
    if (result.insights.toLowerCase().includes('error')) semanticCoherence *= 0.8;
    if (result.insights.toLowerCase().includes('unable to')) semanticCoherence *= 0.7;

    const upstreamInfluence = options.upstreamConfidence ?? 1.0;

    let processingQuality = 0.85;
    if (result.provider === 'groq') processingQuality = 0.9;
    if (result.provider === 'anthropic') processingQuality = 0.95;
    if (result.provider === 'openai') processingQuality = 0.92;
    if (result.provider === 'error') processingQuality = 0;

    return {
      dataCompleteness: Math.min(1, Math.max(0, dataCompleteness)),
      semanticCoherence: Math.min(1, Math.max(0, semanticCoherence)),
      upstreamInfluence: Math.min(1, Math.max(0, upstreamInfluence)),
      processingQuality: Math.min(1, Math.max(0, processingQuality)),
    };
  }

  private computeOverallConfidence(breakdown: {
    dataCompleteness: number;
    semanticCoherence: number;
    upstreamInfluence: number;
    processingQuality: number;
  }): number {
    const weights = {
      dataCompleteness: 0.2,
      semanticCoherence: 0.35,
      upstreamInfluence: 0.2,
      processingQuality: 0.25,
    };

    return (
      breakdown.dataCompleteness * weights.dataCompleteness +
      breakdown.semanticCoherence * weights.semanticCoherence +
      breakdown.upstreamInfluence * weights.upstreamInfluence +
      breakdown.processingQuality * weights.processingQuality
    );
  }

  private detectResultIssues(
    result: AnalysisResult,
    confidence: { dataCompleteness: number; semanticCoherence: number; processingQuality: number }
  ): Array<{
    severity: 'critical' | 'warning' | 'info';
    category: string;
    code: string;
    message: string;
    retryable: boolean;
    suggestedFix?: string;
  }> {
    const issues: Array<{
      severity: 'critical' | 'warning' | 'info';
      category: string;
      code: string;
      message: string;
      retryable: boolean;
      suggestedFix?: string;
    }> = [];

    if (!result.insights || result.insights.length < 20) {
      issues.push({
        severity: 'warning',
        category: 'data_quality',
        code: 'SHORT_INSIGHTS',
        message: 'Analysis returned very short or empty insights',
        retryable: true,
        suggestedFix: 'Increase content detail or use premium tier',
      });
    }

    if (result.confidence < 0.5) {
      issues.push({
        severity: 'warning',
        category: 'low_confidence',
        code: 'LOW_RESULT_CONFIDENCE',
        message: `Analysis confidence is low (${result.confidence.toFixed(2)})`,
        retryable: true,
        suggestedFix: 'Review input quality and retry with premium tier',
      });
    }

    if (confidence.semanticCoherence < 0.5) {
      issues.push({
        severity: 'warning',
        category: 'semantic_mismatch',
        code: 'LOW_SEMANTIC_COHERENCE',
        message: 'Analysis result has low semantic coherence',
        retryable: true,
        suggestedFix: 'Provide more context or clearer input',
      });
    }

    const errorPhrases = ['unable to analyze', 'cannot determine', 'insufficient information', 'error occurred'];
    for (const phrase of errorPhrases) {
      if (result.insights.toLowerCase().includes(phrase)) {
        issues.push({
          severity: 'info',
          category: 'data_quality',
          code: 'ANALYSIS_UNCERTAINTY',
          message: `Analysis indicates uncertainty: "${phrase}"`,
          retryable: false,
        });
        break;
      }
    }

    return issues;
  }

  private generateRoutingSuggestions(
    confidence: number,
    issues: Array<{ severity: string; retryable: boolean; message: string }>,
    options: AnalysisOptions
  ): {
    suggestedNextSteps: string[];
    skipRecommendations: string[];
    escalationNeeded: boolean;
    escalationReason?: string;
    retryRecommendation?: {
      shouldRetry: boolean;
      reason: string;
      suggestedChanges: string;
    };
  } {
    const routing: {
      suggestedNextSteps: string[];
      skipRecommendations: string[];
      escalationNeeded: boolean;
      escalationReason?: string;
      retryRecommendation?: {
        shouldRetry: boolean;
        reason: string;
        suggestedChanges: string;
      };
    } = {
      suggestedNextSteps: [],
      skipRecommendations: [],
      escalationNeeded: false,
    };

    if (confidence < 0.4) {
      const retryableIssues = issues.filter(i => i.retryable);
      if (retryableIssues.length > 0) {
        routing.retryRecommendation = {
          shouldRetry: true,
          reason: `Low confidence (${confidence.toFixed(2)}) with ${retryableIssues.length} retryable issue(s)`,
          suggestedChanges: retryableIssues.map(i => i.message).join('; '),
        };
      }
    }

    const criticalNonRetryable = issues.filter(i => i.severity === 'critical' && !i.retryable);
    if (criticalNonRetryable.length > 0) {
      routing.escalationNeeded = true;
      routing.escalationReason = criticalNonRetryable.map(i => i.message).join('; ');
    }

    if (confidence > 0.7) {
      if (options.analysisType === 'code') {
        routing.suggestedNextSteps.push('ontology_classification', 'insight_generation');
      } else if (options.analysisType === 'patterns') {
        routing.suggestedNextSteps.push('quality_assurance');
      }
    }

    if (confidence < 0.3) {
      routing.skipRecommendations.push('insight_generation');
    }

    return routing;
  }
}
