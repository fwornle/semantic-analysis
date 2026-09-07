import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { log } from "./logging.js";
import { SemanticAnalysisAgent } from "./agents/semantic-analysis-agent.js";
import { SemanticAnalyzer } from "./agents/semantic-analyzer.js";
import { CoordinatorAgent } from "./agents/coordinator.js";
import { InsightGenerationAgent } from "./agents/insight-generation-agent.js";
import { DeduplicationAgent } from "./agents/deduplication.js";
import { WebSearchAgent } from "./agents/web-search.js";
// Phase 42.2 Plan 04 — legacy PersistenceAgent retired. Tool handlers
// now construct the km-core adapter directly and use its surface (plus
// legacy-consumer-helpers for the file-system-only operations).
import { ContentValidationAgent, type EntityRefreshResult } from "./agents/content-validation-agent.js";
import { CodeGraphAgent } from "./agents/code-graph-agent.js";
// Phase 42.2 Plan 04 — GraphDatabaseAdapter retired in favor of the
// km-core adapter (Phase 42-01 strangler surface).
import { createKmCoreAdapter, type KmCoreAdapter } from "./storage/km-core-adapter.js";
import { cleanupEntityFiles as cleanupEntityFilesViaAdapter } from "./storage/legacy-consumer-helpers.js";
import {
  OntologyConfigManager,
  ExtendedOntologyConfig,
} from "./ontology/OntologyConfigManager.js";
// Phase 42-03: legacy ontology-load class deleted. km-core's OntologyRegistry
// (re-exported from the root barrel — the older moduleResolution: node in this
// submodule does not honor the '/ontology' sub-path) is the new source of truth.
// tools.ts itself does not currently instantiate the registry (was a dead import
// pre-Phase-42-03); the explicit import below is retained as a build-time
// guarantee that km-core resolves correctly when the wave-controller bootstrap
// flips on Phase 10's flag.
import { OntologyRegistry } from "@fwornle/km-core";
import { OntologyValidator } from "./ontology/OntologyValidator.js";
import fs from "fs/promises";
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync, openSync, closeSync, readdirSync, appendFileSync } from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { getState, dispatch } from './workflow-state-machine.js';
import { InvalidTransitionError } from './shared/workflow-types/transitions.js';

// ES module compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Server reference for sending progress messages
let serverInstance: Server | null = null;

// Track running async workflows
interface RunningWorkflow {
  id: string;
  workflowName: string;
  startTime: Date;
  repositoryPath: string;
  parameters: Record<string, any>;
  status: 'running' | 'completed' | 'failed';
  error?: string;
  result?: any;
  pid?: number;  // Process ID of detached workflow runner
}
const runningWorkflows = new Map<string, RunningWorkflow>();

/**
 * Set the server instance for sending progress messages
 */
export function setServerInstance(server: Server): void {
  serverInstance = server;
  log("Server instance set for progress updates", "info");
}

/**
 * Send a progress update via MCP logging message
 */
function sendProgressUpdate(workflowId: string, message: string, data?: Record<string, any>): void {
  if (serverInstance) {
    try {
      serverInstance.sendLoggingMessage({
        level: "info",
        data: `📊 [${workflowId}] ${message}${data ? ` | ${JSON.stringify(data)}` : ''}`,
      });
    } catch (error) {
      log(`Failed to send progress update: ${error}`, "warning");
    }
  }
}

/**
 * Clean up any existing running workflows before starting a new one.
 * Prevents multiple workflows from conflicting on the progress file.
 *
 * @returns Object with cleanup results
 */
async function cleanupExistingWorkflows(repositoryPath: string): Promise<{
  cleaned: boolean;
  killedPids: number[];
  staleWorkflowId?: string;
  error?: string;
}> {
  const result = { cleaned: false, killedPids: [] as number[], staleWorkflowId: undefined as string | undefined, error: undefined as string | undefined };

  try {
    const progressPath = path.join(repositoryPath, '.data', 'workflow-progress.json');
    const configDir = path.join(repositoryPath, '.data', 'workflow-configs');

    // Check progress file status for logging purposes
    let progressStatus = 'unknown';
    if (existsSync(progressPath)) {
      try {
        const progressData = JSON.parse(readFileSync(progressPath, 'utf-8'));
        progressStatus = progressData.status || 'unknown';
        result.staleWorkflowId = progressData.workflowId;

        if (progressStatus === 'running') {
          const lastUpdate = new Date(progressData.lastUpdate || progressData.startTime).getTime();
          const now = Date.now();
          const ageMs = now - lastUpdate;
          log(`Found workflow in progress: ${progressData.workflowId || 'unknown'}, age: ${ageMs}ms`, 'info', {
            workflowId: progressData.workflowId,
            lastUpdate: progressData.lastUpdate,
            ageMs,
          });
        }
      } catch { /* ignore parse errors */ }
    }

    // ALWAYS check for running workflow processes, regardless of progress file status
    // This catches cases where progress file was corrupted, process crashed, etc.
    if (existsSync(configDir)) {
      const files = await fs.readdir(configDir);
      const pidFiles = files.filter(f => f.endsWith('.pid'));

      log(`Checking ${pidFiles.length} PID files for running workflow processes`, 'info');

      for (const pidFile of pidFiles) {
        try {
          const pid = parseInt(readFileSync(path.join(configDir, pidFile), 'utf-8').trim(), 10);
          if (pid && !isNaN(pid)) {
            // Check if process is still running
            try {
              process.kill(pid, 0); // Signal 0 = check if process exists

              // Process exists - kill it
              log(`Killing existing workflow process PID ${pid}`, 'warning', { pidFile });
              process.kill(pid, 'SIGTERM');
              result.killedPids.push(pid);
              result.cleaned = true;

              // Wait a moment for process to terminate
              await new Promise(resolve => setTimeout(resolve, 500));

              // Force kill if still running
              try {
                process.kill(pid, 0);
                log(`Process ${pid} still alive, sending SIGKILL`, 'warning');
                process.kill(pid, 'SIGKILL');
              } catch {
                // Process terminated - good
              }
            } catch {
              // Process doesn't exist - that's fine, we'll clean up the file
              log(`PID file ${pidFile} references non-existent process ${pid}`, 'info');
            }

            // Remove pid file (always clean up, process exists or not)
            try {
              unlinkSync(path.join(configDir, pidFile));
              log(`Removed PID file: ${pidFile}`, 'info');
            } catch { /* ignore */ }
          }
        } catch (e) {
          log(`Error processing pid file ${pidFile}: ${e}`, 'warning');
        }
      }
    }

    // Cancel via state machine if currently running (transition to cancelled state)
    if (progressStatus === 'running') {
      try {
        dispatch({ type: 'cancel', reason: 'Cancelled by new workflow start' });
      } catch (err) {
        // If state is already idle/completed/cancelled, InvalidTransitionError is expected
        if (!(err instanceof InvalidTransitionError)) {
          throw err;
        }
        // Fallback: write cancelled status directly to progress file for cross-process scenarios
        // (the detached runner process has its own state machine instance)
        const resetProgress = {
          status: 'cancelled',
          message: 'Cancelled by new workflow start',
          cancelledAt: new Date().toISOString(),
          previousWorkflowId: result.staleWorkflowId,
        };
        writeFileSync(progressPath, JSON.stringify(resetProgress, null, 2));
      }
      result.cleaned = true;
    }

  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    log(`Error during workflow cleanup: ${result.error}`, 'warning');
  }

  return result;
}

/**
 * Generate a unique workflow ID
 */
function generateWorkflowId(): string {
  return `wf_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Convert a name to kebab-case (lowercase with hyphens).
 * Per documentation-style requirements: only lowercase letters, hyphens, and numbers allowed.
 */
function toKebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// Tool definitions
export const TOOLS: Tool[] = [
  {
    name: "heartbeat",
    description: "Send a heartbeat to keep the connection alive (call every 30 seconds)",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "test_connection",
    description: "Test the connection to the semantic analysis server",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "determine_insights",
    description: "Determine insights from analysis results using LLM providers",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Content to analyze for insights",
        },
        context: {
          type: "string", 
          description: "Additional context for the analysis",
        },
        analysis_type: {
          type: "string",
          description: "Type of analysis to perform (general, code, patterns, architecture)",
          enum: ["general", "code", "patterns", "architecture"],
        },
        provider: {
          type: "string",
          description: "Preferred LLM provider (anthropic, openai, auto)",
          enum: ["anthropic", "openai", "auto"],
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "analyze_code",
    description: "Analyze code for patterns, issues, and architectural insights",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Code content to analyze",
        },
        language: {
          type: "string",
          description: "Programming language (if known)",
        },
        file_path: {
          type: "string", 
          description: "File path for context",
        },
        analysis_focus: {
          type: "string",
          description: "Focus area for analysis",
          enum: ["patterns", "quality", "security", "performance", "architecture"],
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "analyze_repository",
    description: "Analyze repository structure and extract architectural patterns",
    inputSchema: {
      type: "object",
      properties: {
        repository_path: {
          type: "string",
          description: "Path to the repository to analyze",
        },
        include_patterns: {
          type: "array",
          items: { type: "string" },
          description: "File patterns to include (e.g., ['*.js', '*.ts'])",
        },
        exclude_patterns: {
          type: "array", 
          items: { type: "string" },
          description: "File patterns to exclude (e.g., ['node_modules', '*.test.js'])",
        },
        max_files: {
          type: "number",
          description: "Maximum number of files to analyze",
        },
      },
      required: ["repository_path"],
      additionalProperties: false,
    },
  },
  {
    name: "extract_patterns",
    description: "Extract reusable design and architectural patterns",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Source content to extract patterns from",
        },
        pattern_types: {
          type: "array",
          items: { type: "string" },
          description: "Types of patterns to look for",
        },
        context: {
          type: "string",
          description: "Additional context about the source",
        },
      },
      required: ["source"],
      additionalProperties: false,
    },
  },
  {
    name: "create_ukb_entity_with_insight",
    description: "Create UKB entity with detailed insight document",
    inputSchema: {
      type: "object",
      properties: {
        entity_name: {
          type: "string",
          description: "Name for the UKB entity",
        },
        entity_type: {
          type: "string", 
          description: "Type of entity (e.g., Pattern, Workflow, Insight)",
        },
        insights: {
          type: "string",
          description: "Detailed insights content",
        },
        significance: {
          type: "number",
          description: "Significance score (1-10)",
          minimum: 1,
          maximum: 10,
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for categorization",
        },
      },
      required: ["entity_name", "entity_type", "insights"],
      additionalProperties: false,
    },
  },
  {
    name: "execute_workflow",
    description: "Execute a predefined analysis workflow. Long-running workflows (complete-analysis, incremental-analysis, batch-analysis) automatically use async mode to prevent MCP timeout. Returns immediately with workflow_id - use get_workflow_status to check progress.",
    inputSchema: {
      type: "object",
      properties: {
        workflow_name: {
          type: "string",
          description: "Name of the workflow to execute (e.g., 'complete-analysis', 'incremental-analysis')",
        },
        parameters: {
          type: "object",
          description: "Optional parameters for the workflow",
          additionalProperties: true,
        },
        async_mode: {
          type: "boolean",
          description: "Run in background (default: true for long workflows like complete-analysis, incremental-analysis). Set to false only for quick workflows.",
        },
        debug: {
          type: "boolean",
          description: "Enable debug mode: activates single-step mode and mock LLM responses from the start. Useful for testing UI visualization without real LLM calls.",
        },
      },
      required: ["workflow_name"],
      additionalProperties: false,
    },
  },
  {
    name: "get_workflow_status",
    description: "Get the status and progress of a running or completed workflow. Reads from the workflow progress file.",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: {
          type: "string",
          description: "The workflow ID returned by execute_workflow in async_mode. If not provided, returns status of most recent workflow.",
        },
        repository_path: {
          type: "string",
          description: "Path to the repository (defaults to current directory)",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "generate_documentation",
    description: "Generate comprehensive documentation from analysis results",
    inputSchema: {
      type: "object",
      properties: {
        analysis_result: {
          type: "object",
          description: "Analysis results to document",
        },
        metadata: {
          type: "object",
          description: "Optional metadata for documentation generation",
          additionalProperties: true,
        },
      },
      required: ["analysis_result"],
      additionalProperties: false,
    },
  },
  {
    name: "create_insight_report",
    description: "Create a detailed insight report with PlantUML diagrams",
    inputSchema: {
      type: "object",
      properties: {
        analysis_result: {
          type: "object",
          description: "Analysis results to create insight from",
        },
        metadata: {
          type: "object",
          description: "Optional metadata including insight name and type",
          additionalProperties: true,
        },
      },
      required: ["analysis_result"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_plantuml_diagrams",
    description: "Generate PlantUML diagrams for analysis results",
    inputSchema: {
      type: "object",
      properties: {
        diagram_type: {
          type: "string",
          description: "Type of diagram (architecture, sequence, use-cases, class)",
          enum: ["architecture", "sequence", "use-cases", "class"],
        },
        content: {
          type: "string",
          description: "Content/title for the diagram",
        },
        name: {
          type: "string",
          description: "Base name for the diagram files",
        },
        analysis_result: {
          type: "object",
          description: "Optional analysis result for context",
          additionalProperties: true,
        },
      },
      required: ["diagram_type", "content", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "reset_analysis_checkpoint",
    description: "Reset the incremental analysis checkpoint to re-analyze from a specific point in time. Useful when you want to re-process commits/sessions that were already analyzed.",
    inputSchema: {
      type: "object",
      properties: {
        timestamp: {
          type: "string",
          description: "ISO timestamp to reset to (e.g., '2025-01-01T00:00:00.000Z'). If not provided, clears the checkpoint entirely to re-analyze everything.",
        },
        days_ago: {
          type: "number",
          description: "Alternative: Reset to N days ago from now. Ignored if 'timestamp' is provided.",
        },
        team: {
          type: "string",
          description: "Team name for the checkpoint file (defaults to 'coding')",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "refresh_entity",
    description: "Validate and refresh a stale knowledge entity. Use entity_name='*' with team to refresh all stale entities in that team, or entity_name='*' with team='*' to refresh all entities globally. Use dry_run=true to preview without making changes.",
    inputSchema: {
      type: "object",
      properties: {
        entity_name: {
          type: "string",
          description: "Name of the entity to refresh (e.g., 'KnowledgePersistencePattern'), or '*' for all entities",
        },
        team: {
          type: "string",
          description: "Team/project name (e.g., 'coding'), or '*' for all teams",
        },
        dry_run: {
          type: "boolean",
          description: "Preview mode - show what would be refreshed without making changes (default: false)",
        },
        score_threshold: {
          type: "number",
          description: "Minimum score threshold below which entities are considered stale (default: 100, meaning any issue triggers refresh)",
        },
        max_entities: {
          type: "number",
          description: "Maximum number of entities to refresh in batch mode (default: 50)",
        },
        force_full_refresh: {
          type: "boolean",
          description: "Force full regeneration of entity content, ignoring last_updated timestamp. Use when entity content is known to be stale despite recent update attempts (default: false)",
        },
        check_entity_name: {
          type: "boolean",
          description: "Normalize entity names by removing version numbers per CLAUDE.md guidelines (default: true when force_full_refresh=true)",
        },
        cleanup_stale_files: {
          type: "boolean",
          description: "Remove orphaned insight/diagram files after refresh (default: false)",
        },
        parallel_workers: {
          type: "number",
          description: "Number of parallel workers for batch refresh (1-20). Higher values speed up batch operations but use more resources. Default: 1 (sequential)",
        },
      },
      required: ["entity_name", "team"],
      additionalProperties: false,
    },
  },
  {
    name: "inject_ontology",
    description: "Inject/swap ontology configuration at runtime. Load a different upper or lower ontology without server restart.",
    inputSchema: {
      type: "object",
      properties: {
        upper_ontology_path: {
          type: "string",
          description: "Path to new upper ontology file (relative to project root)",
        },
        lower_ontology_path: {
          type: "string",
          description: "Path to new lower ontology file (relative to project root)",
        },
        team: {
          type: "string",
          description: "Team name for the lower ontology",
        },
        validation_mode: {
          type: "string",
          description: "Validation mode for the new ontology",
          enum: ["strict", "lenient", "auto-extend"],
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_ontology_status",
    description: "Get current ontology configuration, status, and statistics",
    inputSchema: {
      type: "object",
      properties: {
        include_stats: {
          type: "boolean",
          description: "Include detailed statistics (default: true)",
        },
        team: {
          type: "string",
          description: "Get status for specific team (optional)",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_ontology_classes",
    description: "List available entity classes from the ontology with their properties and inheritance",
    inputSchema: {
      type: "object",
      properties: {
        ontology_type: {
          type: "string",
          description: "Which ontology to list classes from",
          enum: ["upper", "lower", "merged"],
        },
        team: {
          type: "string",
          description: "Team for lower ontology (required if ontology_type is 'lower' or 'merged')",
        },
        include_properties: {
          type: "boolean",
          description: "Include property definitions (default: false)",
        },
        include_relationships: {
          type: "boolean",
          description: "Include relationship definitions (default: false)",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "suggest_ontology_extension",
    description: "Analyze unclassified entities and suggest new ontology classes",
    inputSchema: {
      type: "object",
      properties: {
        team: {
          type: "string",
          description: "Team to analyze unclassified entities for",
        },
        min_entities: {
          type: "number",
          description: "Minimum number of similar entities to suggest a class (default: 3)",
        },
        similarity_threshold: {
          type: "number",
          description: "Similarity threshold for grouping (0-1, default: 0.85)",
        },
        dry_run: {
          type: "boolean",
          description: "Preview suggestions without saving (default: true)",
        },
      },
      required: ["team"],
      additionalProperties: false,
    },
  },
  {
    name: "analyze_code_graph",
    description: "Index and query code using AST-based analysis over the graphify code graph. Reads a static graph.json maintained by the graphify service -- no database required.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Action to perform: index (index a repository), query (search code entities), similar (find similar code), call_graph (get function call graph), nl_query (natural language query)",
          enum: ["index", "query", "similar", "call_graph", "nl_query"],
        },
        repository_path: {
          type: "string",
          description: "Path to the repository to index (for 'index' action)",
        },
        query: {
          type: "string",
          description: "Search query for code entities (for 'query' action)",
        },
        code_snippet: {
          type: "string",
          description: "Code snippet to find similar code for (for 'similar' action)",
        },
        entity_name: {
          type: "string",
          description: "Name of function/method to get call graph for (for 'call_graph' action)",
        },
        question: {
          type: "string",
          description: "Natural language question about the codebase (for 'nl_query' action). Example: 'What functions call registerWithPSM?'",
        },
        entity_types: {
          type: "array",
          items: { type: "string" },
          description: "Filter by entity types: function, class, module, method",
        },
        languages: {
          type: "array",
          items: { type: "string" },
          description: "Filter by programming languages",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return",
        },
        depth: {
          type: "number",
          description: "Depth for call graph traversal (default: 3)",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
];

// Tool call handler
export async function handleToolCall(name: string, args: any): Promise<any> {
  log(`Handling tool call: ${name}`, "info", args);

  try {
    switch (name) {
      case "heartbeat":
        return handleHeartbeat();
        
      case "test_connection":
        return handleTestConnection();
        
      case "determine_insights":
        return await handleDetermineInsights(args);
        
      case "analyze_code":
        return await handleAnalyzeCode(args);
        
      case "analyze_repository":
        return await handleAnalyzeRepository(args);
        
      case "extract_patterns":
        return await handleExtractPatterns(args);
        
      case "create_ukb_entity_with_insight":
        return await handleCreateUkbEntity(args);
        
      case "execute_workflow":
        return await handleExecuteWorkflow(args);

      case "get_workflow_status":
        return await handleGetWorkflowStatus(args);

      case "generate_documentation":
        return await handleGenerateDocumentation(args);
        
      case "create_insight_report":
        return await handleCreateInsightReport(args);
        
      case "generate_plantuml_diagrams":
        return await handleGeneratePlantUMLDiagrams(args);

      case "reset_analysis_checkpoint":
        return await handleResetAnalysisCheckpoint(args);

      case "refresh_entity":
        return await handleRefreshEntity(args);

      case "inject_ontology":
        return await handleInjectOntology(args);

      case "get_ontology_status":
        return await handleGetOntologyStatus(args);

      case "list_ontology_classes":
        return await handleListOntologyClasses(args);

      case "suggest_ontology_extension":
        return await handleSuggestOntologyExtension(args);

      case "analyze_code_graph":
        return await handleAnalyzeCodeGraph(args);

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    log(`Error in tool ${name}:`, "error", error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// Tool implementations
let serverStartTime = Date.now();

function handleHeartbeat(): any {
  const uptime = (Date.now() - serverStartTime) / 1000;
  log("Heartbeat received", "info", { uptime });
  
  return {
    content: [
      {
        type: "text",
        text: `💗 Heartbeat received. Server uptime: ${uptime.toFixed(1)}s`,
      },
    ],
  };
}

function handleTestConnection(): any {
  log("Test connection called", "info");
  
  const timestamp = new Date().toISOString();
  const nodeVersion = process.version;
  const platform = process.platform;
  
  return {
    content: [
      {
        type: "text",
        text: `✅ Semantic Analysis Service Connection Test\n\nServer Status: CONNECTED\nTimestamp: ${timestamp}\nNode.js Version: ${nodeVersion}\nPlatform: ${platform}\nPID: ${process.pid}\n\nAll systems operational!`,
      },
    ],
  };
}

async function handleDetermineInsights(args: any): Promise<any> {
  const { content, context, analysis_type = "general", provider = "auto" } = args;
  
  log(`Determining insights for content (${content.length} chars)`, "info", {
    analysis_type,
    provider,
    has_context: !!context,
  });
  
  try {
    const analyzer = new SemanticAnalyzer();
    log("SemanticAnalyzer created", "info");
    
    const result = await analyzer.analyzeContent(content, {
      context,
      analysisType: analysis_type,
      provider
    });
    
    log("SemanticAnalyzer.analyzeContent completed", "info", {
      hasResult: !!result,
      resultType: typeof result,
      resultKeys: result ? Object.keys(result) : null,
      insightsLength: result?.insights?.length || 0,
      provider: result?.provider || "none"
    });

    if (!result) {
      throw new Error("SemanticAnalyzer returned null/undefined result");
    }

    return {
      content: [
        {
          type: "text", 
          text: `# Semantic Analysis Insights\n\n${result.insights || 'No insights generated'}\n\n## Metadata\n- Provider: ${result.provider || 'Unknown'}\n- Analysis Type: ${analysis_type}\n- Timestamp: ${new Date().toISOString()}`,
        },
      ],
    };
  } catch (error: any) {
    log("Error in handleDetermineInsights", "error", {
      error: error.message,
      stack: error.stack
    });
    
    return {
      content: [
        {
          type: "text",
          text: `# Semantic Analysis Error\n\nError: ${error.message}\n\n## Details\n- Analysis Type: ${analysis_type}\n- Provider: ${provider}\n- Content Length: ${content.length}\n- Has Context: ${!!context}\n- Timestamp: ${new Date().toISOString()}`,
        },
      ],
    };
  }
}

async function handleAnalyzeCode(args: any): Promise<any> {
  const { code, language, file_path, analysis_focus = "patterns" } = args;
  
  log(`Analyzing code (${code.length} chars)`, "info", {
    language,
    file_path,
    analysis_focus,
  });
  
  const analyzer = new SemanticAnalysisAgent();
  const result = await analyzer.analyzeCode(code, language, file_path);
  
  return {
    content: [
      {
        type: "text",
        text: `# Code Analysis Results\n\n${result.analysis}\n\n## Findings\n${result.findings.map((f: string) => `- ${f}`).join('\n')}\n\n## Recommendations\n${result.recommendations.map((r: string) => `- ${r}`).join('\n')}`,
      },
    ],
  };
}

async function handleAnalyzeRepository(args: any): Promise<any> {
  const { repository_path, include_patterns, exclude_patterns, max_files } = args;
  
  log(`Analyzing repository: ${repository_path}`, "info", {
    include_patterns,
    exclude_patterns,
    max_files,
  });
  
  const analyzer = new SemanticAnalysisAgent();
  const result = await analyzer.analyzeRepository(repository_path, {
    includePatterns: include_patterns,
    excludePatterns: exclude_patterns,
    maxFiles: max_files,
  });
  
  return {
    content: [
      {
        type: "text",
        text: `# Repository Analysis\n\n## Structure Overview\n${result.structure}\n\n## Key Patterns\n${result.patterns.map((p: string) => `- ${p}`).join('\n')}\n\n## Architecture Insights\n${result.insights}`,
      },
    ],
  };
}

async function handleExtractPatterns(args: any): Promise<any> {
  const { source, pattern_types, context } = args;
  
  log(`Extracting patterns from source (${source.length} chars)`, "info", {
    pattern_types,
    has_context: !!context,
  });
  
  const analyzer = new SemanticAnalysisAgent();
  const result = await analyzer.extractPatterns(source, pattern_types, context);
  
  return {
    content: [
      {
        type: "text",
        text: `# Extracted Patterns\n\n${result.map((pattern: string) => `- ${pattern}`).join('\n')}`,
      },
    ],
  };
}

async function handleCreateUkbEntity(args: any): Promise<any> {
  const { entity_name, entity_type, insights, significance, tags } = args;

  log(`Creating UKB entity: ${entity_name}`, "info", {
    entity_type,
    significance,
    tags,
  });

  // Phase 42.2 Plan 04 — direct km-core persistence via the strangler adapter
  // (Phase 42-01). Replaces the legacy GraphDatabaseAdapter + PersistenceAgent
  // pair. Constructs a GraphKMStore with the canonical-shape dbPath +
  // ontologyDir (CLAUDE.md mandate) and writes a single entity via
  // adapter.storeEntity.
  const repositoryPath = process.env.REPOSITORY_PATH || process.cwd();
  const km = await import('@fwornle/km-core');
  const dbPath = path.join(repositoryPath, '.data', 'knowledge-graph-migrated', 'leveldb');
  const exportDir = path.join(repositoryPath, '.data', 'knowledge-graph-migrated', 'exports');
  const ontologyDir = path.join(repositoryPath, '.data', 'ontologies');
  const store = new km.GraphKMStore({
    dbPath,
    exportDir,
    ontologyDir,
    domains: ['coding'],
    debounceMs: 5000,
  });
  await store.open();
  const adapter = createKmCoreAdapter({ store, team: 'coding' });

  let success = false;
  let details = '';
  try {
    const result = await adapter.storeEntity(
      {
        name: entity_name,
        entityType: entity_type,
        observations: [insights, ...(tags?.map((t: string) => `Tag: ${t}`) || [])],
        significance: significance || 5,
      },
      { team: 'coding' },
    );
    success = !!result.id;
    details = `Entity id: ${result.id}`;
  } catch (err) {
    details = `storeEntity failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    await adapter.close();
  }

  return {
    content: [
      {
        type: "text",
        text: `# UKB Entity Created\n\n**Name:** ${entity_name}\n**Type:** ${entity_type}\n**Significance:** ${significance || 5}/10\n\n## Status\n${success ? '✅ Successfully created' : '❌ Failed to create'}\n\n## Details\n${details}`,
      },
    ],
  };
}

async function handleExecuteWorkflow(args: any): Promise<any> {
  const { workflow_name, parameters = {}, debug = false } = args;

  // CRITICAL: Force async_mode=true for long-running workflows to prevent MCP timeout crashes
  // These workflows can take 10-20 minutes and will kill the MCP connection if run synchronously
  const longRunningWorkflows = ['complete-analysis', 'incremental-analysis', 'batch-analysis', 'wave-analysis'];
  const forceAsync = longRunningWorkflows.includes(workflow_name);
  const async_mode = args.async_mode ?? forceAsync; // Default to async for long workflows

  // Map legacy workflow names to batch-analysis with appropriate defaults
  const workflowMapping: Record<string, { target: string; defaults: Record<string, any> }> = {
    'complete-analysis': {
      target: 'batch-analysis',
      // fullAnalysis: process ALL commits; forceCleanStart: clear old checkpoints
      // resumeFromCheckpoint: resume if crashes mid-run (new checkpoints created per batch)
      defaults: { fullAnalysis: true, forceCleanStart: true, resumeFromCheckpoint: true }
    },
    'incremental-analysis': {
      target: 'batch-analysis',
      // Fresh start each time - incremental means "since last analysis timestamp", not "resume crashed workflow"
      defaults: { fullAnalysis: false, forceCleanStart: true, resumeFromCheckpoint: true }
    },
    'batch-analysis': {
      target: 'batch-analysis',
      // Fresh start by default - use complete-analysis for crash recovery behavior
      defaults: { forceCleanStart: true, resumeFromCheckpoint: true }
    },
    'wave-analysis': {
      target: 'wave-analysis',
      defaults: {}
    }
  };

  const mapping = workflowMapping[workflow_name];
  const resolvedWorkflowName = mapping?.target || workflow_name;
  const resolvedParameters = mapping ? { ...mapping.defaults, ...parameters } : parameters;

  // Resolve repository path
  let repositoryPath = resolvedParameters?.repository_path || resolvedParameters?.repositoryPath || '.';
  if (repositoryPath === '.' && process.cwd().includes('semantic-analysis')) {
    repositoryPath = path.join(process.cwd(), '../..');
  } else if (repositoryPath && !path.isAbsolute(repositoryPath)) {
    repositoryPath = path.resolve(repositoryPath);
  }

  // Generate workflow ID for tracking
  const workflowId = generateWorkflowId();

  log(`Executing workflow: ${workflow_name} (id: ${workflowId}, async: ${async_mode})`, "info", {
    workflowId,
    originalWorkflow: workflow_name,
    resolvedWorkflow: resolvedWorkflowName,
    asyncMode: async_mode,
    parameters: resolvedParameters
  });

  // Compute debug flags early (needed for both async and sync paths)
  const wantsMockLLM = debug || resolvedParameters?.mockLLM === true;
  const wantsSingleStep = debug || resolvedParameters?.singleStepMode === true;
  const wantsStepIntoSubsteps = debug || resolvedParameters?.stepIntoSubsteps === true;

  log(`Debug settings: debug=${debug}, mockLLM=${wantsMockLLM}, singleStepMode=${wantsSingleStep}, stepIntoSubsteps=${wantsStepIntoSubsteps}`, 'info');

  // If async_mode, spawn a SEPARATE PROCESS to run the workflow
  // This ensures workflow survives MCP disconnections
  if (async_mode) {
    // In Docker, use CODING_ROOT if available (container path differs from host path)
    // This must be consistent for ALL paths to work correctly
    const effectiveRepoPath = process.env.CODING_ROOT || repositoryPath;

    // DEBUG: Trace path resolution
    appendFileSync('/tmp/tools-debug.log', `[${new Date().toISOString()}] async_mode: CODING_ROOT=${process.env.CODING_ROOT}, repositoryPath=${repositoryPath}, effectiveRepoPath=${effectiveRepoPath}\n`);

    // CRITICAL: Clean up any existing running workflows before starting a new one
    // This prevents multiple workflows from conflicting on the shared progress file
    // NOTE: Cleanup may overwrite progress file with { status: 'cancelled' }
    // Debug settings MUST be written AFTER cleanup to avoid being clobbered
    const cleanup = await cleanupExistingWorkflows(effectiveRepoPath);
    if (cleanup.cleaned) {
      log(`Cleaned up existing workflow before starting new one`, 'info', {
        killedPids: cleanup.killedPids,
        previousWorkflowId: cleanup.staleWorkflowId,
      });
    }

    // DEBUG/MOCK MODE: Write settings to progress file BEFORE dispatch.
    // The dispatch triggers the state machine subscriber which writes to the same file.
    // By writing first, the subscriber's merge logic preserves these settings.
    if (wantsMockLLM || wantsSingleStep || wantsStepIntoSubsteps) {
      log(`Writing debug settings to ${effectiveRepoPath}/.data/workflow-progress.json`, 'info');
      const debugProgressFile = path.join(effectiveRepoPath, '.data', 'workflow-progress.json');
      const dataDir = path.join(effectiveRepoPath, '.data');
      mkdirSync(dataDir, { recursive: true });

      let existingProgress: Record<string, any> = {};
      if (existsSync(debugProgressFile)) {
        try {
          existingProgress = JSON.parse(readFileSync(debugProgressFile, 'utf-8'));
        } catch {
          // Ignore parse errors
        }
      }

      const debugProgress: Record<string, any> = {
        ...existingProgress,
        status: 'starting',
      };

      // ALWAYS write singleStepMode and stepIntoSubsteps as top-level fields
      // so the wave-controller can read them without falling back to config
      debugProgress.singleStepMode = !!wantsSingleStep;
      debugProgress.stepIntoSubsteps = !!wantsStepIntoSubsteps;
      if (wantsSingleStep) {
        debugProgress.stepPaused = false;
        debugProgress.pausedAtStep = null;
        debugProgress.singleStepUpdatedAt = new Date().toISOString();
      }
      if (wantsMockLLM) {
        debugProgress.mockLLM = true;
        debugProgress.mockLLMDelay = resolvedParameters?.mockLLMDelay ?? 500;
        debugProgress.mockLLMUpdatedAt = new Date().toISOString();
        debugProgress.llmState = {
          globalMode: 'mock',
          perAgentOverrides: existingProgress.llmState?.perAgentOverrides || {},
          updatedAt: new Date().toISOString()
        };
      }

      writeFileSync(debugProgressFile, JSON.stringify(debugProgress, null, 2));
      log(`Pre-set debug settings: singleStepMode=${wantsSingleStep}, stepIntoSubsteps=${wantsStepIntoSubsteps}, mockLLM=${wantsMockLLM}`, 'info');
    }

    // Dispatch start event to in-process state machine AFTER debug settings are written.
    // The subscriber's merge logic will preserve the debug settings we just wrote.
    try {
      dispatch({
        type: 'start',
        config: {
          singleStepMode: wantsSingleStep,
          mockLLM: wantsMockLLM,
          llmMode: wantsMockLLM ? 'mock' as const : 'public' as const,
          stepIntoSubsteps: wantsStepIntoSubsteps,
        },
        workflowName: resolvedWorkflowName,
        firstStep: 'initializing',
      });
    } catch (err) {
      // If already running, log and continue (cleanup should have cancelled it)
      if (err instanceof InvalidTransitionError) {
        log(`State machine transition warning: ${err.message}`, 'warning');
      }
    }

    // ── wave-analysis runs in obs-api, not in a spawned child ──────────────
    //
    // km-core's LevelDB is single-owner-rw and obs-api owns it for the life of
    // that process. A child spawned from here cannot open it: every
    // wave-analysis run after the Plan 44-12 cutover (2026-06-04) exited 1 one
    // second in with "Database failed to open". Hand the run to the owner over
    // HTTP instead — it executes the same run-wave-analysis.ts against its own
    // open store and writes the same progress file, so the dashboard, the
    // status tool and the [📚] badge all see an unchanged shape.
    //
    // Deliberately NOT falling back to the spawn path when obs-api is
    // unreachable: that fallback is precisely the run that fails a second later
    // with an error naming the database rather than the daemon, which is what
    // made this take three months to notice. Fail here, naming the cause.
    if (resolvedWorkflowName === 'wave-analysis') {
      const obsApiUrl = process.env.OBS_API_URL || 'http://host.docker.internal:12436';
      const runUrl = `${obsApiUrl}/api/workflows/wave-analysis/run`;
      try {
        const resp = await fetch(runUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ team: resolvedParameters?.team || 'coding' }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) {
          throw new Error(`obs-api returned HTTP ${resp.status}`);
        }
        const body = await resp.json() as { jobId?: number; attached?: boolean };
        log('wave-analysis dispatched to obs-api (in-process on the owned store)', 'info', {
          runUrl, jobId: body.jobId, attached: body.attached,
        });
        return {
          content: [{
            type: 'text' as const,
            text: [
              '# Workflow Started (obs-api, in-process)',
              '',
              `**Workflow:** wave-analysis`,
              `**Job:** ${body.jobId ?? 'unknown'}${body.attached ? ' (attached to an in-flight run)' : ''}`,
              `**Host:** ${obsApiUrl}`,
              '',
              'Runs inside obs-api because it owns the km-core store.',
              'Progress: `.data/workflow-progress.json`, `semantic workflow status`,',
              'or GET /api/workflows/wave-analysis/status on obs-api.',
            ].join('\n'),
          }],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log('wave-analysis dispatch to obs-api failed', 'error', { runUrl, error: msg });
        return {
          content: [{
            type: 'text' as const,
            text: [
              '# Workflow NOT started',
              '',
              `Could not reach obs-api at ${runUrl}: ${msg}`,
              '',
              'wave-analysis runs inside obs-api because km-core\'s LevelDB is',
              'single-owner and obs-api holds it. Check the daemon:',
              '',
              '```',
              'launchctl list | grep com.coding.obs-api',
              'curl -s localhost:12436/health',
              '```',
            ].join('\n'),
          }],
          isError: true,
        };
      }
    }

    // Store workflow info locally (for status queries before child writes progress)
    const workflowInfo: RunningWorkflow = {
      id: workflowId,
      workflowName: workflow_name,
      startTime: new Date(),
      repositoryPath: effectiveRepoPath,  // Use effective path
      parameters: resolvedParameters,
      status: 'running',
    };
    runningWorkflows.set(workflowId, workflowInfo);

    // Create config file for the workflow runner
    const configDir = path.join(effectiveRepoPath, '.data', 'workflow-configs');
    mkdirSync(configDir, { recursive: true });

    const configFile = path.join(configDir, `${workflowId}.json`);
    // CRITICAL: Use workflow-progress.json (not workflow-runner-progress.json)
    // The dashboard and Coordinator both read/write workflow-progress.json
    // The heartbeat must write to the same file for status to stay synchronized
    const progressFile = path.join(effectiveRepoPath, '.data', 'workflow-progress.json');
    const pidFile = path.join(configDir, `${workflowId}.pid`);

    const config = {
      workflowId,
      workflowName: workflow_name,
      repositoryPath: effectiveRepoPath,  // Use effective path
      parameters: resolvedParameters,
      progressFile,
      pidFile,
      // DEBUG: trace path resolution
      _debug: {
        CODING_ROOT: process.env.CODING_ROOT || 'NOT_SET',
        originalRepositoryPath: repositoryPath,
        effectiveRepoPath: effectiveRepoPath,
      }
    };

    writeFileSync(configFile, JSON.stringify(config, null, 2));

    // Spawn the workflow runner as a detached process
    const runnerScript = path.join(__dirname, 'workflow-runner.js');

    // Create log file for workflow runner output (captures crashes, errors, debug info)
    const logsDir = path.join(effectiveRepoPath, '.data', 'workflow-logs');
    mkdirSync(logsDir, { recursive: true });
    const logFilePath = path.join(logsDir, `${workflowId}.log`);

    log(`Spawning workflow runner: ${runnerScript}`, 'info', {
      workflowId,
      configFile,
      repositoryPath,
      logFile: logFilePath
    });

    try {
      // Open log file for stdout/stderr capture
      const logFd = openSync(logFilePath, 'a');

      const child = spawn('node', [runnerScript, configFile], {
        cwd: effectiveRepoPath,  // Use effective path for Docker compatibility
        detached: true,  // Run independently of parent
        stdio: ['ignore', logFd, logFd],  // Redirect stdout/stderr to log file
        env: {
          ...process.env,
          WORKFLOW_ID: workflowId,
          WORKFLOW_LOG_FILE: logFilePath,
          NODE_ENV: process.env.NODE_ENV || 'production',
          // Increase heap size to 8GB to handle large accumulated KG operations across 24 batches
          NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
        }
      });

      // Unref so parent can exit without waiting for child
      child.unref();

      // Close file descriptor in parent (child keeps it open)
      closeSync(logFd);

      log(`Workflow runner spawned with PID: ${child.pid}`, 'info', {
        workflowId,
        pid: child.pid,
        logFile: logFilePath
      });

      // Update workflow info with PID
      workflowInfo.pid = child.pid;

    } catch (spawnError) {
      // If spawn fails, clean up and return error
      try { unlinkSync(configFile); } catch (e) { /* ignore */ }
      workflowInfo.status = 'failed';
      workflowInfo.error = spawnError instanceof Error ? spawnError.message : String(spawnError);

      return {
        content: [
          {
            type: "text",
            text: `# Workflow Failed to Start\n\n**Error:** ${workflowInfo.error}\n\nFailed to spawn workflow runner process.`,
          },
        ],
      };
    }

    // Return immediately with workflow ID
    return {
      content: [
        {
          type: "text",
          text: `# Workflow Started (Async Mode)\n\n**Workflow ID:** \`${workflowId}\`\n**Workflow:** ${workflow_name}\n**Repository:** ${repositoryPath}\n**Started:** ${new Date().toISOString()}\n\n## Next Steps\n\nThe workflow is now running in a **separate process** (survives disconnections). To check progress:\n\n\`\`\`\nUse get_workflow_status with workflow_id: "${workflowId}"\n\`\`\`\n\nOr check the progress file at: \`.data/workflow-progress.json\`\n\n**Note:** Progress updates will also be sent via MCP logging messages.`,
        },
      ],
    };
  }

  // Synchronous mode (default) - original behavior with progress updates
  const coordinator = new CoordinatorAgent(repositoryPath);

  // Send initial progress update
  sendProgressUpdate(workflowId, "Starting synchronous workflow execution...");

  try {
    const workflows = coordinator.getWorkflows();
    const workflow = workflows.find(w => w.name === resolvedWorkflowName);
    const isBatchWorkflow = workflow?.type === 'iterative' || resolvedWorkflowName === 'batch-analysis';

    log(`Workflow type: ${workflow?.type || 'standard'}, isBatchWorkflow: ${isBatchWorkflow}`, "info");

    const execution = isBatchWorkflow
      ? await coordinator.executeBatchWorkflow(resolvedWorkflowName, resolvedParameters)
      : await coordinator.executeWorkflow(resolvedWorkflowName, resolvedParameters);

    // Format execution results
    const statusEmoji = execution.status === "completed" ? "✅" : execution.status === "failed" ? "❌" : "⚡";
    const duration = execution.endTime ?
      `${Math.round((execution.endTime.getTime() - execution.startTime.getTime()) / 1000)}s` :
      "ongoing";

    let progressDisplay = `**Steps:** ${execution.currentStep}/${execution.totalSteps}`;
    if (execution.batchProgress) {
      progressDisplay += ` | **Batches:** ${execution.batchProgress.currentBatch}/${execution.batchProgress.totalBatches}`;
    }

    let resultText = `# Workflow Execution\n\n**Workflow ID:** \`${workflowId}\`\n**Workflow:** ${workflow_name}\n**Status:** ${statusEmoji} ${execution.status}\n**Duration:** ${duration}\n${progressDisplay}\n\n## Parameters\n${JSON.stringify(resolvedParameters || {}, null, 2)}\n\n`;

    if (Object.keys(execution.results).length > 0) {
      resultText += "## Results\n";
      for (const [step, result] of Object.entries(execution.results)) {
        resultText += `- **${step}**: ${typeof result === 'object' ? 'Completed' : result}\n`;
      }
      resultText += "\n";
    }

    const qaResults = execution.results.quality_assurance;
    if (qaResults && qaResults.validations) {
      resultText += "## Quality Assurance\n";
      for (const [stepName, qa] of Object.entries(qaResults.validations)) {
        const qaReport = qa as any;
        const qaEmoji = qaReport.passed ? "✅" : "❌";
        resultText += `- **${stepName}**: ${qaEmoji} ${qaReport.passed ? 'Passed' : 'Failed'}\n`;
        if (qaReport.errors && qaReport.errors.length > 0) {
          resultText += `  - Errors: ${qaReport.errors.join(', ')}\n`;
        }
        if (qaReport.warnings && qaReport.warnings.length > 0) {
          resultText += `  - Warnings: ${qaReport.warnings.join(', ')}\n`;
        }
      }
      resultText += "\n";
    }

    if (execution.errors.length > 0) {
      resultText += "## Errors\n";
      for (const error of execution.errors) {
        resultText += `- ${error}\n`;
      }
      resultText += "\n";
    }

    if (execution.status === "completed") {
      resultText += "## Generated Artifacts\n";
      resultText += "**IMPORTANT**: Verify actual file modifications with `git status` before trusting this report.\n\n";
      resultText += "Expected locations for generated files:\n";
      resultText += "- `knowledge-management/insights/` - Insight documents\n";
      resultText += "- `.data/knowledge-export/coding.json` - Knowledge base export (git-tracked)\n";
      resultText += "- `.data/knowledge-graph/` - LevelDB persistent storage\n";
      resultText += "- Generated PlantUML diagrams (.puml and .png files)\n\n";
      resultText += "**VERIFY**: Run `git status` to confirm which files were actually modified.\n";
    }

    sendProgressUpdate(workflowId, `Workflow ${execution.status}`, { duration });

    return {
      content: [{ type: "text", text: resultText }],
    };

  } catch (error) {
    log(`Workflow execution failed: ${workflow_name}`, "error", error);
    sendProgressUpdate(workflowId, `Workflow FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return {
      content: [
        {
          type: "text",
          text: `# Workflow Execution Failed\n\n**Workflow ID:** \`${workflowId}\`\n**Workflow:** ${workflow_name}\n**Error:** ${error instanceof Error ? error.message : String(error)}\n\n## Parameters\n${JSON.stringify(parameters || {}, null, 2)}`,
        },
      ],
    };
  } finally {
    try {
      await coordinator.shutdown();
      log("Coordinator shutdown completed after workflow", "info");
    } catch (shutdownError) {
      log("Error during coordinator shutdown", "error", shutdownError);
    }
  }
}

/**
 * Check if a process with given PID is still running
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = check if process exists
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a workflow is stale (no updates for too long)
 * Returns reason string if stale, null if OK
 */
function checkWorkflowStale(progressData: any): string | null {
  if (!progressData.lastUpdate) return null;

  const lastUpdate = new Date(progressData.lastUpdate).getTime();
  const now = Date.now();
  const staleDurationMs = now - lastUpdate;

  // Consider stale if no update for 2 minutes (heartbeat should happen every 30s)
  const STALE_THRESHOLD_MS = 2 * 60 * 1000;

  if (staleDurationMs > STALE_THRESHOLD_MS) {
    const staleMinutes = Math.round(staleDurationMs / 60000);
    return `No heartbeat for ${staleMinutes} minutes (last update: ${progressData.lastUpdate})`;
  }

  return null;
}

/**
 * Detect and mark crashed workflows
 * Returns updated progress data if crash detected, original otherwise
 */
function detectCrashedWorkflow(progressData: any, repositoryPath: string): any {
  // Only check running workflows
  if (progressData.status !== 'running') {
    return progressData;
  }

  const pid = progressData.pid;
  const processAlive = pid ? isProcessAlive(pid) : false;
  const staleReason = checkWorkflowStale(progressData);

  // If process is dead or stale, mark as crashed
  if (pid && !processAlive) {
    log('[WorkflowStatus] Detected dead workflow process', 'warning', {
      workflowId: progressData.workflowId || progressData.executionId,
      pid,
      lastStep: progressData.currentStep,
      lastUpdate: progressData.lastUpdate
    });

    // Check for log file with crash details
    let crashDetails = `Process ${pid} is no longer running.`;
    const logsDir = path.join(repositoryPath, '.data', 'workflow-logs');
    const workflowId = progressData.workflowId || progressData.executionId;

    if (workflowId) {
      const logFilePath = path.join(logsDir, `wf_${workflowId.replace(/[^a-zA-Z0-9_-]/g, '_')}.log`);
      try {
        // Try to find log file by workflow ID pattern
        const logFiles = readdirSync(logsDir).filter((f: string) => f.includes('wf_'));
        if (logFiles.length > 0) {
          const latestLog = path.join(logsDir, logFiles[logFiles.length - 1]);
          const logContent = readFileSync(latestLog, 'utf-8');
          const lastLines = logContent.split('\n').slice(-20).join('\n');
          if (lastLines.includes('EXCEPTION') || lastLines.includes('Error') || lastLines.includes('MEMORY')) {
            crashDetails += `\n\nLast log entries from ${path.basename(latestLog)}:\n${lastLines}`;
          }
        }
      } catch {
        // Log file may not exist
      }
    }

    // Update progress file to mark as crashed
    const progressFilePath = path.join(repositoryPath, '.data', 'workflow-progress.json');
    const updatedProgress = {
      ...progressData,
      status: 'failed',
      error: `Workflow process crashed: ${crashDetails}`,
      crashDetectedAt: new Date().toISOString()
    };

    try {
      writeFileSync(progressFilePath, JSON.stringify(updatedProgress, null, 2));
    } catch (e) {
      log('[WorkflowStatus] Failed to update crashed workflow status', 'error', e);
    }

    return updatedProgress;
  }

  // If stale but process status unknown, add warning
  if (staleReason && !processAlive) {
    return {
      ...progressData,
      staleWarning: staleReason
    };
  }

  return progressData;
}

/**
 * Get workflow status -- prefers in-memory state machine, falls back to progress file.
 *
 * For in-process workflows (sync mode), getState() is authoritative.
 * For detached workflows (async mode / separate process), the progress file
 * is written by the runner's progress file subscriber and is the cross-process
 * communication mechanism.
 */
async function handleGetWorkflowStatus(args: any): Promise<any> {
  const { workflow_id, repository_path } = args;

  // Check in-memory state machine first (authoritative for in-process workflows)
  const machineState = getState();
  if (machineState.status !== 'idle') {
    // State machine has an active/terminal workflow -- use it directly
    const statusEmoji = machineState.status === 'completed' ? '++' :
                        machineState.status === 'failed' ? 'XX' :
                        machineState.status === 'running' ? '>>' :
                        machineState.status === 'cancelled' ? '--' : '||';

    let statusText = `# Workflow Status (State Machine)\n\n`;
    statusText += `**Status:** ${statusEmoji} ${machineState.status}\n`;

    if (machineState.status === 'running' || machineState.status === 'paused') {
      statusText += `**Workflow:** ${machineState.workflowName}\n`;
      statusText += `**Current Step:** ${machineState.progress.currentStepName}\n`;
      statusText += `**Steps Completed:** ${machineState.progress.completedSteps.length}\n`;
      statusText += `**Elapsed:** ${machineState.progress.elapsedSeconds}s\n`;
    } else if (machineState.status === 'completed') {
      statusText += `**Workflow:** ${machineState.workflowName}\n`;
      statusText += `**Steps Completed:** ${machineState.completedSteps}\n`;
      statusText += `**Duration:** ${machineState.duration}s\n`;
    } else if (machineState.status === 'failed') {
      statusText += `**Workflow:** ${machineState.workflowName}\n`;
      statusText += `**Failed Step:** ${machineState.failedStep}\n`;
      statusText += `**Error:** ${machineState.error}\n`;
    } else if (machineState.status === 'cancelled') {
      statusText += `**Workflow:** ${machineState.workflowName}\n`;
      statusText += `**Last Step:** ${machineState.lastStep}\n`;
      statusText += `**Cancelled At:** ${machineState.cancelledAt}\n`;
    }

    return { content: [{ type: "text", text: statusText }] };
  }

  // Fall back to progress file for detached (async) workflows
  // Resolve repository path
  let repoPath = repository_path || '.';
  if (repoPath === '.' && process.cwd().includes('semantic-analysis')) {
    repoPath = path.join(process.cwd(), '../..');
  } else if (repoPath && !path.isAbsolute(repoPath)) {
    repoPath = path.resolve(repoPath);
  }

  const progressFilePath = path.join(repoPath, '.data', 'workflow-progress.json');
  const runnerProgressFilePath = path.join(repoPath, '.data', 'workflow-runner-progress.json');

  // Check for detached workflow runner progress first (process-isolated workflows)
  try {
    if (existsSync(runnerProgressFilePath)) {
      const runnerProgress = JSON.parse(readFileSync(runnerProgressFilePath, 'utf-8'));

      // Check if this matches the requested workflow_id (or no specific ID requested)
      if (!workflow_id || runnerProgress.workflowId === workflow_id) {
        const statusEmoji = runnerProgress.status === 'completed' ? '✅' :
                            runnerProgress.status === 'failed' ? '❌' :
                            runnerProgress.status === 'running' ? '🔄' : '⏸️';

        let statusText = `# Workflow Status (Process-Isolated)\n\n`;
        statusText += `**Workflow ID:** \`${runnerProgress.workflowId}\`\n`;
        statusText += `**Status:** ${statusEmoji} ${runnerProgress.status || 'unknown'}\n`;
        statusText += `**PID:** ${runnerProgress.pid || 'N/A'}\n`;
        statusText += `**Elapsed:** ${runnerProgress.elapsedSeconds || 0}s\n`;
        statusText += `**Started:** ${runnerProgress.startTime || 'N/A'}\n`;
        statusText += `**Last Update:** ${runnerProgress.lastUpdate || 'N/A'}\n`;

        if (runnerProgress.message) {
          statusText += `**Message:** ${runnerProgress.message}\n`;
        }

        if (runnerProgress.currentStep) {
          statusText += `\n## Progress Details\n`;
          statusText += `- **Current Step:** ${runnerProgress.currentStep}\n`;
          if (runnerProgress.stepsCompleted !== undefined && runnerProgress.totalSteps !== undefined) {
            statusText += `- **Steps:** ${runnerProgress.stepsCompleted}/${runnerProgress.totalSteps}\n`;
          }
          if (runnerProgress.batchProgress) {
            statusText += `- **Batch:** ${runnerProgress.batchProgress.currentBatch}/${runnerProgress.batchProgress.totalBatches}\n`;
          }
        }

        if (runnerProgress.error) {
          statusText += `\n## Error\n${runnerProgress.error}\n`;
        }

        // Also merge with coordinator progress if available
        if (existsSync(progressFilePath)) {
          try {
            const coordProgress = JSON.parse(readFileSync(progressFilePath, 'utf-8'));
            if (coordProgress.currentStep) {
              statusText += `\n## Coordinator Progress\n`;
              statusText += `- **Current Step:** ${coordProgress.currentStep}\n`;
              statusText += `- **Steps:** ${coordProgress.stepsCompleted || 0}/${coordProgress.totalSteps || 0}\n`;
              if (coordProgress.batchProgress) {
                statusText += `- **Batch:** ${coordProgress.batchProgress.currentBatch}/${coordProgress.batchProgress.totalBatches}\n`;
              }
            }
          } catch (e) {
            // Ignore parsing errors
          }
        }

        return { content: [{ type: "text", text: statusText }] };
      }
    }
  } catch (e) {
    // Runner progress file may not exist or be malformed
  }

  // Check running workflows in-memory (legacy/non-detached)
  if (workflow_id && runningWorkflows.has(workflow_id)) {
    const wf = runningWorkflows.get(workflow_id)!;
    const elapsed = Math.round((Date.now() - wf.startTime.getTime()) / 1000);

    let statusText = `# Workflow Status\n\n**Workflow ID:** \`${wf.id}\`\n**Workflow:** ${wf.workflowName}\n**Status:** ${wf.status === 'running' ? '🔄 Running' : wf.status === 'completed' ? '✅ Completed' : '❌ Failed'}\n**Elapsed:** ${elapsed}s\n**Started:** ${wf.startTime.toISOString()}\n`;

    if (wf.pid) {
      statusText += `**PID:** ${wf.pid}\n`;
    }

    if (wf.error) {
      statusText += `\n## Error\n${wf.error}\n`;
    }

    // Also read progress file for detailed progress
    try {
      if (existsSync(progressFilePath)) {
        const progressData = JSON.parse(readFileSync(progressFilePath, 'utf-8'));
        statusText += `\n## Progress Details\n`;
        statusText += `- **Current Step:** ${progressData.currentStep || 'N/A'}\n`;
        statusText += `- **Steps:** ${progressData.completedSteps || 0}/${progressData.totalSteps || 0}\n`;
        if (progressData.batchProgress) {
          statusText += `- **Batch:** ${progressData.batchProgress.currentBatch}/${progressData.batchProgress.totalBatches}\n`;
        }
        if (progressData.runningSteps && progressData.runningSteps.length > 0) {
          statusText += `- **Running Steps:** ${progressData.runningSteps.join(', ')}\n`;
        }
      }
    } catch (e) {
      // Progress file may not exist yet
    }

    return { content: [{ type: "text", text: statusText }] };
  }

  // Read progress file directly
  try {
    if (!existsSync(progressFilePath)) {
      return {
        content: [{
          type: "text",
          text: `# No Workflow Progress Found\n\nNo workflow progress file found at: \`${progressFilePath}\`\n\nEither no workflow has been run, or the progress file has been cleaned up.`,
        }],
      };
    }

    let progressData = JSON.parse(readFileSync(progressFilePath, 'utf-8'));

    // CRITICAL: Detect crashed workflows (process dead but status still "running")
    // This updates the progress file and returns the corrected status
    progressData = detectCrashedWorkflow(progressData, repoPath);

    const statusEmoji = progressData.status === 'completed' ? '✅' :
                        progressData.status === 'failed' ? '❌' :
                        progressData.status === 'running' ? '🔄' : '⏸️';

    let statusText = `# Workflow Progress\n\n`;
    statusText += `**Status:** ${statusEmoji} ${progressData.status || 'unknown'}\n`;
    statusText += `**Workflow:** ${progressData.workflowName || 'N/A'}\n`;
    statusText += `**Current Step:** ${progressData.currentStep || 'N/A'}\n`;
    statusText += `**Progress:** ${progressData.completedSteps || 0}/${progressData.totalSteps || 0} steps\n`;

    if (progressData.batchProgress) {
      statusText += `**Batch Progress:** ${progressData.batchProgress.currentBatch}/${progressData.batchProgress.totalBatches}\n`;
      if (progressData.batchProgress.batchId) {
        statusText += `**Current Batch ID:** ${progressData.batchProgress.batchId}\n`;
      }
    }

    if (progressData.startTime) {
      statusText += `**Started:** ${progressData.startTime}\n`;
    }
    if (progressData.lastUpdate) {
      statusText += `**Last Update:** ${progressData.lastUpdate}\n`;
    }
    if (progressData.pid) {
      const pidStatus = isProcessAlive(progressData.pid) ? '(alive)' : '(dead)';
      statusText += `**PID:** ${progressData.pid} ${pidStatus}\n`;
    }

    // Show crash detection info
    if (progressData.crashDetectedAt) {
      statusText += `**Crash Detected:** ${progressData.crashDetectedAt}\n`;
    }

    // Show stale warning
    if (progressData.staleWarning) {
      statusText += `\n## ⚠️ Warning\n${progressData.staleWarning}\n`;
    }

    if (progressData.runningSteps && progressData.runningSteps.length > 0) {
      statusText += `\n## Currently Running\n`;
      for (const step of progressData.runningSteps) {
        statusText += `- 🔄 ${step}\n`;
      }
    }

    if (progressData.error) {
      statusText += `\n## Error\n${progressData.error}\n`;
    }

    if (progressData.errors && progressData.errors.length > 0) {
      statusText += `\n## Errors\n`;
      for (const error of progressData.errors) {
        statusText += `- ❌ ${error}\n`;
      }
    }

    return { content: [{ type: "text", text: statusText }] };

  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `# Error Reading Workflow Status\n\n**Error:** ${error instanceof Error ? error.message : String(error)}\n\n**Path:** ${progressFilePath}`,
      }],
    };
  }
}

// Helper functions for formatting documentation sections
function formatDetailedFindings(analysis: any): string {
  if (!analysis) return "No detailed findings available.";
  
  const findings = [];
  
  // Add repository structure findings
  if (analysis.structure) {
    findings.push("### Repository Structure");
    findings.push(analysis.structure);
  }
  
  // Add key patterns
  if (analysis.patterns || analysis.key_patterns) {
    findings.push("\n### Key Patterns Identified");
    const patterns = analysis.patterns || analysis.key_patterns;
    if (Array.isArray(patterns)) {
      patterns.forEach((pattern: string) => findings.push(`- ${pattern}`));
    } else {
      findings.push(patterns);
    }
  }
  
  // Add insights
  if (analysis.insights) {
    findings.push("\n### Architectural Insights");
    findings.push(analysis.insights);
  }
  
  return findings.join("\n") || "Analysis completed successfully.";
}

function formatQualityMetrics(analysis: any): string {
  const metrics = [];
  
  if (analysis.complexity || analysis.complexity_score) {
    metrics.push(`- **Complexity Score**: ${analysis.complexity || analysis.complexity_score}/10`);
  }
  
  if (analysis.files_analyzed) {
    metrics.push(`- **Files Analyzed**: ${analysis.files_analyzed}`);
  }
  
  if (analysis.patterns?.length) {
    metrics.push(`- **Patterns Detected**: ${analysis.patterns.length}`);
  }
  
  metrics.push(`- **Architecture Type**: ${analysis.architecture_type || "Not specified"}`);
  metrics.push(`- **Maturity Level**: ${analysis.maturity || "Not assessed"}`);
  
  return metrics.join("\n") || "Quality metrics pending assessment.";
}

function formatArchitectureInsights(analysis: any): string {
  if (analysis.architecture_insights) {
    return analysis.architecture_insights;
  }
  
  const insights = [];
  
  if (analysis.architecture_type) {
    insights.push(`The system demonstrates a **${analysis.architecture_type}** architecture.`);
  }
  
  if (analysis.key_patterns?.length) {
    insights.push("\nKey architectural patterns include:");
    analysis.key_patterns.forEach((pattern: string) => {
      insights.push(`- ${pattern}`);
    });
  }
  
  return insights.join("\n") || "Architecture analysis pending.";
}

function formatPatternAnalysis(analysis: any): string {
  const patterns = [];
  
  if (analysis.patterns || analysis.key_patterns) {
    const patternList = analysis.patterns || analysis.key_patterns;
    patterns.push("### Identified Patterns\n");
    
    if (Array.isArray(patternList)) {
      patternList.forEach((pattern: string) => {
        patterns.push(`#### ${pattern}`);
        patterns.push("- **Usage**: Detected in multiple components");
        patterns.push("- **Impact**: Contributes to system maintainability\n");
      });
    }
  }
  
  return patterns.join("\n") || "Pattern analysis in progress.";
}

function formatRecommendations(analysis: any): string {
  if (analysis.recommendations) {
    return Array.isArray(analysis.recommendations) 
      ? analysis.recommendations.map((r: any) => `- ${r}`).join("\n")
      : analysis.recommendations;
  }
  
  const recommendations = [
    "1. **Documentation**: Enhance inline documentation for complex components",
    "2. **Testing**: Increase test coverage for critical paths",
    "3. **Architecture**: Consider implementing monitoring for distributed components",
    "4. **Performance**: Optimize shared memory access patterns"
  ];
  
  return recommendations.join("\n");
}

function formatAppendices(analysis: any): string {
  const appendices = [];
  
  appendices.push("### Analysis Metadata");
  appendices.push(`- **Analysis Date**: ${new Date().toISOString()}`);
  appendices.push(`- **Repository Path**: ${analysis.repository_path || "Not specified"}`);
  appendices.push(`- **Analysis Type**: Comprehensive Semantic Analysis`);
  
  if (analysis.metadata) {
    appendices.push("\n### Additional Metadata");
    Object.entries(analysis.metadata).forEach(([key, value]) => {
      appendices.push(`- **${key}**: ${value}`);
    });
  }
  
  return appendices.join("\n");
}

async function handleGenerateDocumentation(args: any): Promise<any> {
  const { analysis_result, metadata } = args;
  
  log("Generating documentation with real file writing", "info", { has_metadata: !!metadata });
  
  try {
    const docAgent = new InsightGenerationAgent();
    
    // Map the analysis result to the expected template variables
    const documentationData = {
      analysis_title: metadata?.title || analysis_result?.title || "Semantic Analysis Report",
      scope: analysis_result?.scope || analysis_result?.repository_path || "Repository analysis",
      duration: analysis_result?.duration || "Not measured",
      analyzed_items: analysis_result?.analyzed_items || 
                      `${analysis_result?.files_analyzed || 0} files analyzed`,
      methodology: analysis_result?.methodology || 
                   "Comprehensive semantic analysis using 8-agent architecture with AI-powered insights",
      results_summary: analysis_result?.summary || analysis_result?.results_summary || 
                       "Analysis completed successfully with insights extracted",
      detailed_findings: formatDetailedFindings(analysis_result),
      quality_metrics: formatQualityMetrics(analysis_result),
      architecture_insights: formatArchitectureInsights(analysis_result),
      pattern_analysis: formatPatternAnalysis(analysis_result),
      recommendations: formatRecommendations(analysis_result),
      appendices: formatAppendices(analysis_result),
      timestamp: new Date().toISOString()
    };
    
    // Generate the documentation content
    const docResult = await docAgent.generateDocumentation("analysis_documentation", documentationData);
    
    // Save the documentation to files
    const today = new Date().toISOString().split('T')[0];
    const insightsDir = process.env.KNOWLEDGE_BASE_PATH;
    if (!insightsDir) {
      throw new Error('KNOWLEDGE_BASE_PATH environment variable not set');
    }
    const outputPath = `${insightsDir}/${today}-semantic-analysis.md`;
    
    await docAgent.saveDocumentation(docResult, outputPath);
    
    log(`Documentation saved to file: ${outputPath}`, "info", {
      title: docResult.title,
      contentLength: docResult.content.length
    });
    
    return {
      content: [
        {
          type: "text",
          text: `# Generated Documentation\n\n**File Created:** ${outputPath}\n**Title:** ${docResult.title}\n**Size:** ${docResult.content.length} chars\n**Generated:** ${docResult.generatedAt}\n\n## Preview\n\n${docResult.content.substring(0, 500)}${docResult.content.length > 500 ? '...' : ''}`,
        },
      ],
      metadata: {
        filePath: outputPath,
        fileSize: docResult.content.length,
        title: docResult.title
      }
    };
    
  } catch (error) {
    log("Failed to generate documentation", "error", error);
    return {
      content: [
        {
          type: "text",
          text: `# Documentation Generation Failed\n\nError: ${error instanceof Error ? error.message : String(error)}\n\nFalling back to basic documentation...`,
        },
      ],
    };
  }
}

async function handleCreateInsightReport(args: any): Promise<any> {
  const { analysis_result, metadata } = args;

  log("Creating insight report", "info", { has_metadata: !!metadata });

  const insightName = metadata?.name || "Analysis Insight";
  const insightType = metadata?.type || "General";
  const repositoryPath = metadata?.repositoryPath || process.cwd();

  try {
    const insightAgent = new InsightGenerationAgent(repositoryPath);

    // Build pattern catalog from analysis result
    const patternCatalog = analysis_result?.patternCatalog || {
      patterns: analysis_result?.patterns || [{
        name: insightName,
        category: insightType,
        description: analysis_result?.description || 'Generated insight',
        significance: metadata?.significance || 7,
        evidence: analysis_result?.evidence || [],
        relatedComponents: analysis_result?.relatedComponents || [],
        implementation: {
          language: 'typescript',
          usageNotes: []
        }
      }],
      summary: {
        totalPatterns: 1,
        byCategory: { [insightType]: 1 },
        avgSignificance: metadata?.significance || 7,
        topPatterns: [insightName]
      }
    };

    // Call the real insight generation
    const result = await insightAgent.generateComprehensiveInsights({
      patternCatalog,
      gitAnalysis: analysis_result?.gitAnalysis,
      vibeAnalysis: analysis_result?.vibeAnalysis,
      semanticAnalysis: analysis_result?.semanticAnalysis,
      webResults: analysis_result?.webResults
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            insightName,
            insightType,
            insightDocument: result.insightDocument,
            patternCatalog: result.patternCatalog,
            metrics: result.generationMetrics,
            diagrams: result.insightDocument?.diagrams || []
          }, null, 2)
        }
      ]
    };
  } catch (error) {
    log(`Insight report generation failed: ${error}`, 'error');
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            insightName,
            insightType
          }, null, 2)
        }
      ]
    };
  }
}

async function handleGeneratePlantUMLDiagrams(args: any): Promise<any> {
  const { diagram_type, content, name, analysis_result } = args;
  
  // 🔍 TRACE: Log what arguments we received
  log(`🔍 DEBUG: handleGeneratePlantUMLDiagrams called with:`, "debug", {
    diagram_type,
    content,
    name,
    hasAnalysisResult: !!analysis_result,
    analysisResultType: typeof analysis_result,
    analysisResultKeys: analysis_result ? Object.keys(analysis_result) : [],
    argsKeys: Object.keys(args)
  });
  
  log(`Generating PlantUML diagram: ${name}`, "info", { diagram_type });
  
  // Use LLM-enhanced diagram generation instead of static templates
  const insightAgent = new InsightGenerationAgent();
  let diagramContent = '';
  
  try {
    // Try LLM-enhanced generation first
    log(`Attempting LLM-enhanced ${diagram_type} diagram generation`, "info");
    
    const dataForLLM = { 
      patternCatalog: analysis_result,
      content,
      name 
    };
    
    log(`🔍 DEBUG: Data being passed to LLM:`, "debug", {
      hasPatternCatalog: !!dataForLLM.patternCatalog,
      patternCatalogType: typeof dataForLLM.patternCatalog,
      content: dataForLLM.content,
      name: dataForLLM.name
    });
    
    diagramContent = await insightAgent.generateLLMEnhancedDiagram(diagram_type, dataForLLM);
    
    if (diagramContent && diagramContent.includes('@startuml')) {
      log(`LLM-enhanced diagram generated successfully`, "info", { length: diagramContent.length });
    } else {
      log(`LLM-enhanced diagram generation failed, content: ${diagramContent}`, "warning");
      throw new Error('LLM diagram generation failed - no valid PlantUML content');
    }
  } catch (error) {
    log(`LLM diagram generation failed: ${error}`, "error");
    return {
      content: [
        {
          type: "text",
          text: `❌ LLM-Enhanced PlantUML Generation Failed\n\n**Error:** ${error instanceof Error ? error.message : String(error)}\n\n**Diagram Type:** ${diagram_type}\n**Name:** ${name}\n\n**Root Cause:** The LLM provider could not generate repository-specific diagram content. This indicates either:\n1. Missing analysis data in the input\n2. LLM provider configuration issues\n3. Insufficient semantic analysis results\n\n**Solution:** Please check the semantic analysis results and ensure they contain meaningful patterns and components before attempting diagram generation.`
        }
      ],
      isError: true,
    };
  }
  
  try {
    // Set up directory structure
    const insightsDir = process.env.KNOWLEDGE_BASE_PATH;
    if (!insightsDir) {
      throw new Error('KNOWLEDGE_BASE_PATH environment variable not set');
    }
    const pumlDir = path.join(insightsDir, 'puml');
    const imagesDir = path.join(insightsDir, 'images');
    
    // Ensure directories exist
    mkdirSync(pumlDir, { recursive: true });
    mkdirSync(imagesDir, { recursive: true });
    
    // Generate kebab-case filename for consistency with documentation-style requirements
    const fileBaseName = toKebabCase(name);
    const pumlFile = path.join(pumlDir, `${fileBaseName}-${diagram_type}.puml`);
    
    // Write the PlantUML file
    writeFileSync(pumlFile, diagramContent);
    
    log(`PlantUML file created: ${pumlFile}`, "info", {
      name,
      diagram_type,
      fileSize: diagramContent.length
    });
    
    // Generate PNG image using plantuml command
    const pngFile = path.join(imagesDir, `${fileBaseName}-${diagram_type}.png`);
    let pngGenerated = false;
    
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      // Use relative path to avoid nested directory creation
      const relativePath = path.relative(path.dirname(pumlFile), imagesDir);
      await execAsync(`plantuml -tpng "${pumlFile}" -o "${relativePath}"`);
      pngGenerated = true;
      
      log(`PNG file generated: ${pngFile}`, "info", {
        pumlFile,
        pngFile
      });
      
    } catch (error) {
      log(`Failed to generate PNG: ${error}`, "warning", {
        pumlFile,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    
    return {
      content: [
        {
          type: "text",
          text: `# PlantUML Diagram Generated\n\n**PUML File:** ${pumlFile}\n**PNG File:** ${pngGenerated ? pngFile : 'Not generated'}\n**Type:** ${diagram_type}\n**Title:** ${content || name}\n**Size:** ${diagramContent.length} chars\n**Generated:** ${new Date().toISOString()}\n\n## Preview\n\`\`\`plantuml\n${diagramContent}\n\`\`\`\n\n${pngGenerated ? '✅ PNG image successfully generated!' : '⚠️ PNG generation failed - check PlantUML installation'}`
        }
      ],
      metadata: {
        filePath: pumlFile,
        fileSize: diagramContent.length,
        diagramType: diagram_type
      }
    };
  } catch (error) {
    log(`Error generating PlantUML diagram`, "error", error);
    throw error;
  }
}

function generateContextAwareDiagram(diagram_type: string, content: string, name: string, analysis_result: any): string {
  const baseTitle = content || name || "System";
  
  switch (diagram_type) {
    case "architecture":
      return generateArchitectureDiagram(baseTitle, analysis_result);
    case "sequence":
      return generateSequenceDiagram(baseTitle, analysis_result);
    case "use-cases":
      return generateUseCasesDiagram(baseTitle, analysis_result);
    case "integration":
      return generateIntegrationDiagram(baseTitle, analysis_result);
    default:
      return generateArchitectureDiagram(baseTitle, analysis_result);
  }
}

function generateArchitectureDiagram(title: string, analysis: any): string {
  // Extract meaningful components from analysis data
  let components = [];
  
  // Debug: log what we received
  log(`PlantUML generateArchitectureDiagram called`, 'debug', {
    title,
    hasAnalysis: !!analysis,
    hasSemanticInsights: !!analysis?.semanticInsights,
    hasPatterns: !!analysis?.semanticInsights?.patterns,
    hasCommits: !!analysis?.commits,
    hasArchDecisions: !!analysis?.architecturalDecisions,
    analysisKeys: analysis ? Object.keys(analysis) : []
  });

  log(`generateArchitectureDiagram called with analysis:`, 'debug', { 
    hasAnalysis: !!analysis, 
    hasSemanticInsights: !!analysis?.semanticInsights,
    hasPatterns: !!analysis?.semanticInsights?.patterns,
    hasCommits: !!analysis?.commits,
    hasArchDecisions: !!analysis?.architecturalDecisions,
    analysisKeys: analysis ? Object.keys(analysis) : []
  });
  
  // Try different sources for meaningful components
  if (analysis?.semanticInsights?.patterns) {
    components = analysis.semanticInsights.patterns.map((p: any) => p.name || p.pattern).slice(0, 8);
    log(`Using semantic insights patterns:`, 'debug', components);
  } else if (analysis?.codeAnalysis?.patterns) {
    components = analysis.codeAnalysis.patterns.map((p: any) => p.name || p.pattern).slice(0, 8);
    log(`Using code analysis patterns:`, 'debug', components);
  } else if (analysis?.commits && analysis.commits.length > 0) {
    // Extract components from git commit messages and file changes
    const fileTypes = new Set<string>();
    analysis.commits.forEach((commit: any) => {
      if (commit.files) {
        commit.files.forEach((file: any) => {
          const fileName = typeof file === 'string' ? file : String(file);
          const ext = fileName.split('.').pop();
          if (ext) {
            if (ext.includes('ts') || ext.includes('js')) fileTypes.add('TypeScript/JavaScript Engine');
            if (ext.includes('json')) fileTypes.add('Configuration Manager');
            if (ext.includes('md')) fileTypes.add('Documentation System');
            if (fileName.includes('agent')) fileTypes.add('Agent Framework');
            if (fileName.includes('mcp')) fileTypes.add('MCP Protocol Handler');
          }
        });
      }
    });
    components = Array.from(fileTypes).slice(0, 6);
    log(`Using components from git commits:`, 'debug', components);
  } else if (analysis?.architecturalDecisions) {
    // Use architectural decisions as components
    components = analysis.architecturalDecisions.map((d: any) => d.component || d.area || 'System Component').slice(0, 6);
    log(`Using architectural decisions:`, 'debug', components);
  }
  
  // Fallback to meaningful default components if still empty
  if (components.length === 0) {
    components = [
      "Semantic Analysis Engine", 
      "Knowledge Management System", 
      "PlantUML Generator",
      "Quality Assurance Agent",
      "MCP Protocol Handler"
    ];
  }
  
  const hasSharedMemory = components.some((p: string) => p.toLowerCase().includes("shared") || p.toLowerCase().includes("memory"));
  
  let diagram = `@startuml ${title.toLowerCase().replace(/\s+/g, '-')}-architecture
!theme plain
title ${title} - Architecture Diagram

skinparam component {
  BackgroundColor<<service>> LightBlue
  BackgroundColor<<storage>> LightGreen
  BackgroundColor<<agent>> LightYellow
}

`;

  if (hasSharedMemory) {
    diagram += `package "Distributed System Architecture" {
  component "Service Orchestrator" as SO <<service>>
  component "Shared Memory Layer" as SM <<storage>>
  
  package "Domain Components" {
    component "UI Component" as UI <<agent>>
    component "Coding Component" as CODE <<agent>>
    component "RESI Component" as RESI <<agent>>
  }
  
  database "Persistent Storage" as DB <<storage>>
}

SO --> SM : Manages
UI --> SM : Read/Write
CODE --> SM : Read/Write
RESI --> SM : Read/Write
SM --> DB : Persist

`;
  } else {
    diagram += `package "System Architecture" {
`;
    components.forEach((comp: string, idx: number) => {
      diagram += `  component "${comp}" as C${idx} <<service>>\n`;
    });
    
    // Add some relationships
    for (let i = 0; i < components.length - 1; i++) {
      diagram += `  C${i} --> C${i + 1} : interacts\n`;
    }
    
    diagram += `}`;
  }
  
  diagram += `

note right
  Complexity Score: ${analysis?.complexity || "N/A"}/10
  Architecture Type: ${analysis?.architecture_type || "Distributed"}
end note

@enduml`;
  
  return diagram;
}

function generateSequenceDiagram(title: string, analysis: any): string {
  return `@startuml ${title.toLowerCase().replace(/\s+/g, '-')}-sequence
!theme plain
title ${title} - Sequence Diagram

actor User
participant "CLI Interface" as CLI
participant "MCP Server" as MCP
participant "Coordinator Agent" as COORD
participant "Repository Analyzer" as REPO
participant "Semantic Analyzer" as SEM
participant "Documentation Agent" as DOC
participant "Knowledge Manager" as KM

User -> CLI : semantic-analysis
CLI -> MCP : execute_workflow
MCP -> COORD : start workflow
COORD -> REPO : analyze_repository
REPO --> COORD : structure & patterns
COORD -> SEM : determine_insights
SEM --> COORD : architectural insights
COORD -> DOC : generate_documentation
DOC --> COORD : markdown & diagrams
COORD -> KM : create_entities
KM --> COORD : knowledge updated
COORD --> MCP : workflow complete
MCP --> CLI : results
CLI --> User : artifacts generated

@enduml`;
}

function generateUseCasesDiagram(title: string, analysis: any): string {
  return `@startuml ${title.toLowerCase().replace(/\s+/g, '-')}-use-cases
!theme plain
title ${title} - Use Cases Diagram

left to right direction
skinparam packageStyle rect

actor Developer
actor "CI/CD System" as CI
actor "Team Member" as Team

rectangle "Semantic Analysis System" {
  usecase "Analyze Repository" as UC1
  usecase "Extract Patterns" as UC2
  usecase "Generate Insights" as UC3
  usecase "Create Documentation" as UC4
  usecase "Update Knowledge Base" as UC5
  usecase "Generate Diagrams" as UC6
  usecase "Quality Validation" as UC7
}

Developer --> UC1
Developer --> UC2
UC1 --> UC3 : triggers
UC3 --> UC4 : triggers
UC3 --> UC5 : triggers
UC4 --> UC6 : includes
UC1 --> UC7 : validated by

CI --> UC1 : automated
Team --> UC5 : accesses

@enduml`;
}

function generateIntegrationDiagram(title: string, analysis: any): string {
  return `@startuml ${title.toLowerCase().replace(/\s+/g, '-')}-integration
!theme plain
title ${title} - Integration Diagram

skinparam component {
  BackgroundColor<<external>> Pink
  BackgroundColor<<internal>> LightBlue
  BackgroundColor<<storage>> LightGreen
}

package "Internal Systems" <<internal>> {
  component "MCP Server" as MCP
  component "8-Agent System" as AGENTS
  component "Knowledge Manager" as KM
}

package "External Integrations" <<external>> {
  component "Claude AI" as CLAUDE
  component "Git Repository" as GIT
  component "File System" as FS
}

package "Storage Layer" <<storage>> {
  database "MCP Memory" as MEMORY
  database "Shared Memory JSON" as JSON
  database "Insights Repository" as INSIGHTS
}

CLAUDE --> MCP : MCP Protocol
MCP --> AGENTS : Coordinates
AGENTS --> GIT : Analyzes
AGENTS --> FS : Read/Write
AGENTS --> KM : Updates

KM --> MEMORY : Sync
KM --> JSON : Persist
AGENTS --> INSIGHTS : Generate

note bottom of INSIGHTS
  - Markdown files
  - PlantUML diagrams
  - PNG images
  - Code snippets
end note

@enduml`;
}

/**
 * Handler for reset_analysis_checkpoint tool
 * Allows resetting the incremental analysis marker to re-analyze from a specific point
 */
async function handleResetAnalysisCheckpoint(args: any): Promise<any> {
  const { timestamp, days_ago, team = 'coding' } = args;

  log(`Resetting analysis checkpoint for team: ${team}`, "info", { timestamp, days_ago });

  try {
    // Determine the new checkpoint timestamp
    let newCheckpoint: string;
    let description: string;

    if (timestamp) {
      // Use provided timestamp
      const date = new Date(timestamp);
      if (isNaN(date.getTime())) {
        throw new Error(`Invalid timestamp format: ${timestamp}`);
      }
      newCheckpoint = date.toISOString();
      description = `specific timestamp: ${newCheckpoint}`;
    } else if (days_ago !== undefined && days_ago >= 0) {
      // Calculate timestamp from days_ago
      const date = new Date();
      date.setDate(date.getDate() - days_ago);
      newCheckpoint = date.toISOString();
      description = `${days_ago} days ago (${newCheckpoint})`;
    } else {
      // Clear checkpoint entirely - this will re-analyze everything
      newCheckpoint = '';
      description = 'cleared (will re-analyze from the beginning)';
    }

    const repositoryPath = process.env.REPOSITORY_PATH || process.cwd();

    // IMPORTANT: Reset BOTH checkpoint locations
    // 1. Primary: .data/workflow-checkpoints.json (used by CheckpointManager)
    // 2. Legacy: .data/knowledge-export/{team}.json (for backwards compatibility)

    // 1. Reset the primary workflow-checkpoints.json file (CheckpointManager reads this FIRST)
    const workflowCheckpointsFile = path.join(repositoryPath, '.data', 'workflow-checkpoints.json');
    let workflowCheckpoints: any = {};
    try {
      const content = await fs.readFile(workflowCheckpointsFile, 'utf8');
      workflowCheckpoints = JSON.parse(content);
    } catch {
      // File doesn't exist yet
    }

    const oldWorkflowCheckpoint = workflowCheckpoints.lastGitAnalysis || workflowCheckpoints.lastSuccessfulWorkflowCompletion || 'not set';

    if (newCheckpoint) {
      workflowCheckpoints.lastGitAnalysis = newCheckpoint;
      workflowCheckpoints.lastVibeAnalysis = newCheckpoint;
      workflowCheckpoints.lastSuccessfulWorkflowCompletion = newCheckpoint;
    } else {
      delete workflowCheckpoints.lastGitAnalysis;
      delete workflowCheckpoints.lastVibeAnalysis;
      delete workflowCheckpoints.lastSuccessfulWorkflowCompletion;
    }
    workflowCheckpoints.lastUpdated = new Date().toISOString();
    workflowCheckpoints.checkpointResetAt = new Date().toISOString();
    workflowCheckpoints.checkpointResetReason = description;

    await fs.writeFile(workflowCheckpointsFile, JSON.stringify(workflowCheckpoints, null, 2), 'utf8');
    log(`Primary checkpoint file reset: ${workflowCheckpointsFile}`, "info");

    // 2. Also reset the legacy knowledge-export file (for backwards compatibility)
    const legacyCheckpointFile = path.join(repositoryPath, '.data', 'knowledge-export', `${team}.json`);

    log(`Legacy checkpoint file: ${legacyCheckpointFile}`, "info");

    // Read current file
    let data: any = { entities: [], relations: [], metadata: {} };
    try {
      const content = await fs.readFile(legacyCheckpointFile, 'utf8');
      data = JSON.parse(content);
    } catch (error) {
      log(`Legacy checkpoint file not found or invalid, creating new one`, "warning");
      data.metadata = {};
    }

    // Store the old value for reporting
    const oldCheckpoint = data.metadata?.lastSuccessfulWorkflowCompletion || oldWorkflowCheckpoint;

    // Update or clear the checkpoint
    if (newCheckpoint) {
      data.metadata.lastSuccessfulWorkflowCompletion = newCheckpoint;
    } else {
      delete data.metadata.lastSuccessfulWorkflowCompletion;
    }

    // Also update related timestamps for consistency
    data.metadata.last_updated = new Date().toISOString();
    data.metadata.checkpointResetAt = new Date().toISOString();
    data.metadata.checkpointResetReason = description;

    // Write back to file
    await fs.writeFile(legacyCheckpointFile, JSON.stringify(data, null, 2), 'utf8');

    log(`Checkpoint reset successfully`, "info", { oldCheckpoint, newCheckpoint: newCheckpoint || 'cleared' });

    return {
      content: [
        {
          type: "text",
          text: `# Analysis Checkpoint Reset\n\n**Team:** ${team}\n**Previous checkpoint:** ${oldCheckpoint}\n**New checkpoint:** ${description}\n\n**Files updated:**\n- Primary: ${workflowCheckpointsFile}\n- Legacy: ${legacyCheckpointFile}\n\n**Updated:** ${new Date().toISOString()}\n\n---\n\nThe next \`ukb\` (incremental-analysis) run will now analyze changes since ${description}.\n\n**Tip:** Use \`days_ago: 7\` to re-analyze the last week, or omit both parameters to re-analyze everything.`
        }
      ],
      metadata: {
        team,
        oldCheckpoint,
        newCheckpoint: newCheckpoint || null,
        workflowCheckpointsFile,
        legacyCheckpointFile,
        description
      }
    };
  } catch (error) {
    log(`Error resetting checkpoint`, "error", error);
    throw error;
  }
}

/**
 * Handler for refresh_entity tool
 * Validates and optionally refreshes stale knowledge entities using LLM
 */
async function handleRefreshEntity(args: any): Promise<any> {
  const {
    entity_name,
    team,
    dry_run = false,
    score_threshold = 100,
    max_entities = 50,
    force_full_refresh = false,
    check_entity_name,  // Default handled below based on force_full_refresh
    cleanup_stale_files = false,
    parallel_workers = 1  // Default to sequential, can be 1-20
  } = args;

  // Default check_entity_name to true when force_full_refresh is true
  const shouldCheckName = check_entity_name ?? force_full_refresh;

  log(`Refreshing entity`, "info", {
    entity_name, team, dry_run, score_threshold, force_full_refresh,
    check_entity_name: shouldCheckName, cleanup_stale_files, parallel_workers
  });

  try {
    const repositoryPath = process.env.REPOSITORY_PATH || process.cwd();

    // Initialize ContentValidationAgent with required dependencies
    const contentValidationAgent = new ContentValidationAgent({
      repositoryPath,
      enableDeepValidation: true,
      team: team === '*' ? 'coding' : team
    });

    // Phase 42.2 Plan 04 — initialize the km-core adapter (replaces the
    // legacy GraphDatabaseAdapter + PersistenceAgent pair). Same dbPath +
    // ontologyDir + exportDir as wave-controller / coordinator. The single
    // setKmCoreAdapter call replaces the legacy setGraphDB + setPersistenceAgent
    // pair (collapsed in Phase 42.2 Plan 04 Task 3).
    const teamForAdapter = team === '*' ? 'coding' : team;
    const km = await import('@fwornle/km-core');
    const dbPath = path.join(repositoryPath, '.data', 'knowledge-graph-migrated', 'leveldb');
    const exportDir = path.join(repositoryPath, '.data', 'knowledge-graph-migrated', 'exports');
    const ontologyDir = path.join(repositoryPath, '.data', 'ontologies');
    const store = new km.GraphKMStore({
      dbPath,
      exportDir,
      ontologyDir,
      domains: [teamForAdapter],
      debounceMs: 5000,
    });
    await store.open();
    const adapter: KmCoreAdapter = createKmCoreAdapter({ store, team: teamForAdapter });
    contentValidationAgent.setKmCoreAdapter(adapter);

    // Single entity refresh vs batch refresh
    if (entity_name === '*') {
      // Batch refresh mode
      const teamParam = team === '*' ? undefined : team;

      log(`Starting batch refresh`, "info", { team: teamParam, dry_run, max_entities });

      const batchResult = await contentValidationAgent.refreshAllStaleEntities({
        team: teamParam,
        scoreThreshold: score_threshold,
        dryRun: dry_run,
        maxEntities: max_entities,
        forceFullRefresh: force_full_refresh,
        parallelWorkers: parallel_workers
      });

      // Format response
      let responseText = `# Entity Refresh ${dry_run ? '(Dry Run)' : 'Results'}\n\n`;
      responseText += `**Summary:** ${batchResult.summary}\n\n`;

      if (batchResult.confirmationRequired) {
        responseText += `## Entities Needing Refresh\n\n`;
        responseText += `| Entity | Score | Issues |\n|--------|-------|--------|\n`;
        for (const entity of batchResult.confirmationRequired.entitiesAffected) {
          responseText += `| ${entity.name} | ${entity.currentScore}/100 | ${entity.issues} |\n`;
        }
        responseText += `\n${batchResult.confirmationRequired.message}\n`;
      }

      if (!dry_run && batchResult.results.length > 0) {
        responseText += `\n## Refresh Results\n\n`;
        for (const result of batchResult.results) {
          const status = result.success ? '✅' : '❌';
          const scoreBefore = result.validationBefore.overallScore;
          const scoreAfter = result.validationAfter?.overallScore ?? scoreBefore;
          responseText += `- ${status} **${result.entityName}**: ${scoreBefore} → ${scoreAfter}`;
          if (result.error) {
            responseText += ` (Error: ${result.error})`;
          }
          responseText += '\n';
        }
      }

      return {
        content: [{ type: "text", text: responseText }],
        metadata: {
          dry_run: batchResult.dryRun,
          entities_scanned: batchResult.entitiesScanned,
          entities_needing_refresh: batchResult.entitiesNeedingRefresh,
          entities_refreshed: batchResult.entitiesRefreshed,
          entities_failed: batchResult.entitiesFailed
        }
      };

    } else {
      // Single entity refresh
      log(`Refreshing single entity: ${entity_name}`, "info");

      if (dry_run) {
        // Dry run: just validate, don't refresh
        const validationReport = await contentValidationAgent.validateEntityAccuracy(entity_name, team);

        let responseText = `# Entity Validation (Dry Run)\n\n`;
        responseText += `**Entity:** ${entity_name}\n`;
        responseText += `**Team:** ${team}\n`;
        responseText += `**Score:** ${validationReport.overallScore}/100\n`;
        responseText += `**Valid:** ${validationReport.overallValid ? 'Yes' : 'No'}\n`;
        responseText += `**Issues:** ${validationReport.totalIssues} (${validationReport.criticalIssues} critical)\n\n`;

        if (validationReport.suggestedActions.removeObservations.length > 0) {
          responseText += `## Stale Observations to Remove\n\n`;
          for (const obs of validationReport.suggestedActions.removeObservations) {
            responseText += `- ${obs.substring(0, 100)}...\n`;
          }
        }

        if (validationReport.recommendations.length > 0) {
          responseText += `\n## Recommendations\n\n`;
          for (const rec of validationReport.recommendations) {
            responseText += `- ${rec}\n`;
          }
        }

        responseText += `\n---\n*Set dry_run=false to apply these changes.*`;

        return {
          content: [{ type: "text", text: responseText }],
          metadata: {
            dry_run: true,
            entity_name,
            team,
            validation_score: validationReport.overallScore,
            issues: validationReport.totalIssues
          }
        };

      } else {
        // Actually refresh the entity
        const refreshResult = await contentValidationAgent.refreshStaleEntity({
          entityName: entity_name,
          team: team,
          forceFullRefresh: force_full_refresh,
          checkEntityName: shouldCheckName
        });

        // Optional: Clean up orphaned files after refresh
        // Phase 42.2 Plan 04 — adapter-backed cleanup via free-function helper
        // (file-system-only operation with one optional adapter query for
        // orphan detection). insightsDir defaults to the project convention.
        let cleanupResult: { deletedFiles: string[]; errors: string[] } | undefined;
        if (cleanup_stale_files) {
          const insightsDir = path.join(repositoryPath, 'knowledge-management', 'insights');
          cleanupResult = await cleanupEntityFilesViaAdapter(adapter, insightsDir, {
            entityName: entity_name === '*' ? undefined : entity_name,
            team: team,
            cleanOrphans: entity_name === '*'
          });
        }

        let responseText = `# Entity Refresh Results\n\n`;
        // Use the potentially renamed entity name from the result
        const displayEntityName = refreshResult.renamedTo || entity_name;
        responseText += `**Entity:** ${displayEntityName}\n`;
        responseText += `**Team:** ${team}\n`;
        responseText += `**Success:** ${refreshResult.success ? 'Yes' : 'No'}\n\n`;

        if (refreshResult.error) {
          responseText += `**Error:** ${refreshResult.error}\n\n`;
        } else {
          // Report entity rename if it happened
          if (refreshResult.renamedFrom && refreshResult.renamedTo) {
            responseText += `## Entity Renamed\n\n`;
            responseText += `- From: \`${refreshResult.renamedFrom}\`\n`;
            responseText += `- To: \`${refreshResult.renamedTo}\`\n`;
            responseText += `- Reason: Numbers removed per CLAUDE.md guidelines\n\n`;
          }

          responseText += `## Score Improvement\n\n`;
          responseText += `- Before: ${refreshResult.validationBefore.overallScore}/100\n`;
          responseText += `- After: ${refreshResult.validationAfter?.overallScore ?? 'N/A'}/100\n\n`;

          if (refreshResult.observationChanges.removed.length > 0) {
            responseText += `## Removed Observations (${refreshResult.observationChanges.removed.length})\n\n`;
            for (const obs of refreshResult.observationChanges.removed) {
              responseText += `- ~~${obs.substring(0, 80)}...~~\n`;
            }
          }

          if (refreshResult.observationChanges.added.length > 0) {
            responseText += `\n## Added Observations (${refreshResult.observationChanges.added.length})\n\n`;
            for (const obs of refreshResult.observationChanges.added) {
              responseText += `- ${obs.substring(0, 80)}...\n`;
            }
          }

          // Report on insight document generation
          if (refreshResult.insightRefreshed) {
            responseText += `\n## Insight Document\n\n`;
            responseText += `- Insight document generated/refreshed\n`;
          }

          // Report on diagram regeneration
          if (refreshResult.diagramsRegenerated && refreshResult.diagramsRegenerated.length > 0) {
            responseText += `\n## Diagrams Regenerated (${refreshResult.diagramsRegenerated.length})\n\n`;
            for (const diagram of refreshResult.diagramsRegenerated) {
              responseText += `- ${diagram}\n`;
            }
          }

          // Report on file cleanup if performed
          if (cleanupResult && cleanupResult.deletedFiles.length > 0) {
            responseText += `\n## Files Cleaned Up (${cleanupResult.deletedFiles.length})\n\n`;
            for (const file of cleanupResult.deletedFiles) {
              responseText += `- ${file}\n`;
            }
          }
        }

        return {
          content: [{ type: "text", text: responseText }],
          metadata: {
            dry_run: false,
            entity_name: displayEntityName,
            original_entity_name: refreshResult.renamedFrom || entity_name,
            team,
            success: refreshResult.success,
            score_before: refreshResult.validationBefore.overallScore,
            score_after: refreshResult.validationAfter?.overallScore,
            observations_removed: refreshResult.observationChanges.removed.length,
            observations_added: refreshResult.observationChanges.added.length,
            insight_refreshed: refreshResult.insightRefreshed,
            diagrams_regenerated: refreshResult.diagramsRegenerated?.length || 0,
            renamed_from: refreshResult.renamedFrom,
            renamed_to: refreshResult.renamedTo,
            files_cleaned_up: cleanupResult?.deletedFiles?.length || 0
          }
        };
      }
    }

  } catch (error) {
    log(`Error refreshing entity`, "error", error);
    throw error;
  }
}

// ============================================================================
// Ontology Management Tool Handlers
// ============================================================================

/**
 * Singleton reference to OntologyConfigManager
 */
let ontologyConfigManager: OntologyConfigManager | null = null;

/**
 * Get or create the ontology config manager instance
 */
async function getOntologyConfigManager(): Promise<OntologyConfigManager> {
  if (!ontologyConfigManager) {
    const basePath = process.env.KNOWLEDGE_BASE_PATH || process.cwd();
    const defaultConfig: ExtendedOntologyConfig = {
      enabled: true,
      upperOntologyPath: path.join(basePath, '.data/ontologies/upper/development-knowledge-ontology.json'),
      lowerOntologyPath: path.join(basePath, '.data/ontologies/lower/coding-ontology.json'),
      team: 'coding',
      validation: {
        mode: 'lenient',
        failOnError: false,
        allowUnknownProperties: true,
      },
      classification: {
        useUpper: true,
        useLower: true,
        minConfidence: 0.7,
        enableLLM: true,  // Enable LLM for proper semantic classification
        enableHeuristics: true,
        llmBudgetPerClassification: 500,
      },
      caching: {
        enabled: true,
        maxEntries: 100,
        ttl: 300000,
      },
      hotReload: true,
      watchInterval: 5000,
    };

    ontologyConfigManager = OntologyConfigManager.getInstance(defaultConfig);
    await ontologyConfigManager.initialize();
  }
  return ontologyConfigManager;
}

/**
 * Handle inject_ontology tool - Load/swap ontology at runtime
 */
async function handleInjectOntology(args: {
  upper_ontology_path?: string;
  lower_ontology_path?: string;
  team?: string;
  validation_mode?: 'strict' | 'lenient' | 'auto-extend';
}): Promise<any> {
  log("Injecting ontology", "info", args);

  const configManager = await getOntologyConfigManager();

  try {
    await configManager.injectOntology({
      upperOntologyPath: args.upper_ontology_path,
      lowerOntologyPath: args.lower_ontology_path,
      team: args.team,
      validationMode: args.validation_mode,
    });

    const status = configManager.getStatus();

    return {
      content: [
        {
          type: "text",
          text: `# Ontology Injected Successfully

## Current Configuration
- **Upper Ontology**: ${status.upperOntologyPath}
- **Lower Ontology**: ${status.lowerOntologyPath || 'None'}
- **Team**: ${status.team || 'Default'}
- **Hot Reload**: ${status.hotReload ? 'Enabled' : 'Disabled'}
- **Watched Files**: ${status.watchedFiles.length}

The ontology system is now using the specified configuration. All new entity classifications will use this ontology.`,
        },
      ],
      metadata: {
        success: true,
        ...status,
      },
    };
  } catch (error) {
    throw new Error(`Failed to inject ontology: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Handle get_ontology_status tool - Get current ontology configuration and stats
 */
async function handleGetOntologyStatus(args: {
  include_classes?: boolean;
  include_team_configs?: boolean;
}): Promise<any> {
  log("Getting ontology status", "info", args);

  const configManager = await getOntologyConfigManager();
  const status = configManager.getStatus();
  const config = configManager.getConfig();

  let responseText = `# Ontology System Status

## Configuration
- **Enabled**: ${status.enabled}
- **Initialized**: ${status.initialized}
- **Hot Reload**: ${status.hotReload}

## Ontology Paths
- **Upper Ontology**: ${status.upperOntologyPath}
- **Lower Ontology**: ${status.lowerOntologyPath || 'Not configured'}
- **Team**: ${status.team || 'None'}

## Auto-Extend Settings
- **Enabled**: ${status.autoExtend.enabled}
- **Suggestion Threshold**: ${status.autoExtend.suggestionThreshold}
- **Require Approval**: ${status.autoExtend.requireApproval}
- **Similarity Threshold**: ${status.autoExtend.similarityThreshold}
- **Suggestions Path**: ${status.autoExtend.suggestionsPath}

## Classification Settings
- **Use Upper**: ${config.classification?.useUpper}
- **Use Lower**: ${config.classification?.useLower}
- **Min Confidence**: ${config.classification?.minConfidence}
- **LLM Enabled**: ${config.classification?.enableLLM}
- **Heuristics Enabled**: ${config.classification?.enableHeuristics}

## Validation Settings
- **Mode**: ${config.validation?.mode}
- **Fail on Error**: ${config.validation?.failOnError}
- **Allow Unknown Properties**: ${config.validation?.allowUnknownProperties}

## Watched Files (${status.watchedFiles.length})
${status.watchedFiles.map((f: string) => `- ${f}`).join('\n') || 'None'}

## Registered Teams (${status.registeredTeams.length})
${status.registeredTeams.map((t: string) => `- ${t}`).join('\n') || 'None'}
`;

  // Optionally include team configs
  if (args.include_team_configs) {
    const teamConfigs = configManager.getAllTeamConfigs();
    if (teamConfigs.size > 0) {
      responseText += `\n## Team Configuration Details\n`;
      for (const [team, teamConfig] of teamConfigs) {
        responseText += `\n### ${team}
- **Lower Ontology**: ${teamConfig.lowerOntologyPath}
- **Validation Mode**: ${teamConfig.validation?.mode || 'default'}
- **Min Confidence**: ${teamConfig.classification?.minConfidence || 'default'}
`;
      }
    }
  }

  return {
    content: [{ type: "text", text: responseText }],
    metadata: {
      ...status,
      config: config,
    },
  };
}

/**
 * Handle list_ontology_classes tool - List available entity classes
 */
async function handleListOntologyClasses(args: {
  ontology_type?: 'upper' | 'lower' | 'merged';
  team?: string;
  include_properties?: boolean;
  include_relationships?: boolean;
  filter_parent?: string;
}): Promise<any> {
  log("Listing ontology classes", "info", args);

  const configManager = await getOntologyConfigManager();
  const status = configManager.getStatus();
  const config = configManager.getConfig();

  // Load and parse ontology files
  const basePath = process.env.KNOWLEDGE_BASE_PATH || process.cwd();

  let classes: Array<{
    name: string;
    description: string;
    parent?: string;
    source: 'upper' | 'lower';
    properties?: any;
  }> = [];

  let relationships: Array<{
    name: string;
    description: string;
    source: 'upper' | 'lower';
    sourceEntityClass?: string;
    targetEntityClass?: string;
    cardinality?: string;
    properties?: any;
  }> = [];

  // Load upper ontology
  if (args.ontology_type !== 'lower') {
    try {
      const upperPath = path.isAbsolute(status.upperOntologyPath)
        ? status.upperOntologyPath
        : path.join(basePath, status.upperOntologyPath);
      const upperContent = await fs.readFile(upperPath, 'utf-8');
      const upperOntology = JSON.parse(upperContent);

      // Support both 'entities' (current format) and 'entityDefinitions' (legacy format)
      const upperEntities = upperOntology.entities || upperOntology.entityDefinitions;
      if (upperEntities) {
        for (const [name, def] of Object.entries(upperEntities)) {
          const entityDef = def as any;
          if (!args.filter_parent || entityDef.extendsEntity === args.filter_parent) {
            classes.push({
              name,
              description: entityDef.description || '',
              parent: entityDef.extendsEntity,
              source: 'upper',
              properties: args.include_properties ? entityDef.properties : undefined,
            });
          }
        }
      }

      // Load relationships if requested
      if (args.include_relationships && upperOntology.relationships) {
        for (const [name, def] of Object.entries(upperOntology.relationships)) {
          const relDef = def as any;
          relationships.push({
            name,
            description: relDef.description || '',
            source: 'upper',
            sourceEntityClass: relDef.sourceEntityClass,
            targetEntityClass: relDef.targetEntityClass,
            cardinality: relDef.cardinality,
            properties: relDef.properties,
          });
        }
      }
    } catch (error) {
      log("Failed to load upper ontology", "warning", error);
    }
  }

  // Load lower ontology
  if (args.ontology_type !== 'upper' && status.lowerOntologyPath) {
    try {
      const lowerPath = path.isAbsolute(status.lowerOntologyPath)
        ? status.lowerOntologyPath
        : path.join(basePath, status.lowerOntologyPath);
      const lowerContent = await fs.readFile(lowerPath, 'utf-8');
      const lowerOntology = JSON.parse(lowerContent);

      // Support both 'entities' (current format) and 'entityDefinitions' (legacy format)
      const lowerEntities = lowerOntology.entities || lowerOntology.entityDefinitions;
      if (lowerEntities) {
        for (const [name, def] of Object.entries(lowerEntities)) {
          const entityDef = def as any;
          if (!args.filter_parent || entityDef.extendsEntity === args.filter_parent) {
            classes.push({
              name,
              description: entityDef.description || '',
              parent: entityDef.extendsEntity,
              source: 'lower',
              properties: args.include_properties ? entityDef.properties : undefined,
            });
          }
        }
      }

      // Load relationships if requested
      if (args.include_relationships && lowerOntology.relationships) {
        for (const [name, def] of Object.entries(lowerOntology.relationships)) {
          const relDef = def as any;
          relationships.push({
            name,
            description: relDef.description || '',
            source: 'lower',
            sourceEntityClass: relDef.sourceEntityClass,
            targetEntityClass: relDef.targetEntityClass,
            cardinality: relDef.cardinality,
            properties: relDef.properties,
          });
        }
      }
    } catch (error) {
      log("Failed to load lower ontology", "warning", error);
    }
  }

  // Sort classes by source then name
  classes.sort((a, b) => {
    if (a.source !== b.source) return a.source === 'upper' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // Format response
  let responseText = `# Ontology Entity Classes

**Ontology Type**: ${args.ontology_type || 'merged'}
**Total Classes**: ${classes.length}
${args.filter_parent ? `**Filtered by Parent**: ${args.filter_parent}` : ''}

`;

  // Group by source
  const upperClasses = classes.filter(c => c.source === 'upper');
  const lowerClasses = classes.filter(c => c.source === 'lower');

  if (args.ontology_type !== 'lower' && upperClasses.length > 0) {
    responseText += `## Upper Ontology Classes (${upperClasses.length})\n\n`;
    for (const cls of upperClasses) {
      responseText += `### ${cls.name}\n`;
      responseText += `- **Description**: ${cls.description || 'No description'}\n`;
      if (cls.parent) responseText += `- **Extends**: ${cls.parent}\n`;
      if (args.include_properties && cls.properties && typeof cls.properties === 'object') {
        responseText += `- **Properties**:\n`;
        // Handle properties as object (dictionary) with name as key
        for (const [propName, propDef] of Object.entries(cls.properties)) {
          const prop = propDef as any;
          responseText += `  - \`${propName}\` (${prop.type || 'unknown'}): ${prop.description || ''}\n`;
        }
      }
      responseText += '\n';
    }
  }

  if (args.ontology_type !== 'upper' && lowerClasses.length > 0) {
    responseText += `## Lower Ontology Classes (${lowerClasses.length})\n\n`;
    for (const cls of lowerClasses) {
      responseText += `### ${cls.name}\n`;
      responseText += `- **Description**: ${cls.description || 'No description'}\n`;
      if (cls.parent) responseText += `- **Extends**: ${cls.parent}\n`;
      if (args.include_properties && cls.properties && typeof cls.properties === 'object') {
        responseText += `- **Properties**:\n`;
        // Handle properties as object (dictionary) with name as key
        for (const [propName, propDef] of Object.entries(cls.properties)) {
          const prop = propDef as any;
          responseText += `  - \`${propName}\` (${prop.type || 'unknown'}): ${prop.description || ''}\n`;
        }
      }
      responseText += '\n';
    }
  }

  // Add relationships section if requested
  if (args.include_relationships && relationships.length > 0) {
    const upperRels = relationships.filter(r => r.source === 'upper');
    const lowerRels = relationships.filter(r => r.source === 'lower');

    responseText += `## Relationships\n\n`;

    if (upperRels.length > 0) {
      responseText += `### Upper Ontology Relationships (${upperRels.length})\n\n`;
      for (const rel of upperRels) {
        responseText += `#### ${rel.name}\n`;
        responseText += `- **Description**: ${rel.description || 'No description'}\n`;
        if (rel.sourceEntityClass) responseText += `- **Source**: ${rel.sourceEntityClass}\n`;
        if (rel.targetEntityClass) responseText += `- **Target**: ${rel.targetEntityClass}\n`;
        if (rel.cardinality) responseText += `- **Cardinality**: ${rel.cardinality}\n`;
        if (rel.properties && typeof rel.properties === 'object') {
          responseText += `- **Properties**: ${Object.keys(rel.properties).join(', ')}\n`;
        }
        responseText += '\n';
      }
    }

    if (lowerRels.length > 0) {
      responseText += `### Lower Ontology Relationships (${lowerRels.length})\n\n`;
      for (const rel of lowerRels) {
        responseText += `#### ${rel.name}\n`;
        responseText += `- **Description**: ${rel.description || 'No description'}\n`;
        if (rel.sourceEntityClass) responseText += `- **Source**: ${rel.sourceEntityClass}\n`;
        if (rel.targetEntityClass) responseText += `- **Target**: ${rel.targetEntityClass}\n`;
        if (rel.cardinality) responseText += `- **Cardinality**: ${rel.cardinality}\n`;
        if (rel.properties && typeof rel.properties === 'object') {
          responseText += `- **Properties**: ${Object.keys(rel.properties).join(', ')}\n`;
        }
        responseText += '\n';
      }
    }
  }

  return {
    content: [{ type: "text", text: responseText }],
    metadata: {
      ontology_type: args.ontology_type || 'merged',
      total_classes: classes.length,
      upper_classes: upperClasses.length,
      lower_classes: lowerClasses.length,
      classes: classes,
      relationships: args.include_relationships ? relationships : undefined,
    },
  };
}

/**
 * Handle suggest_ontology_extension tool - Analyze and suggest new entity classes
 */
async function handleSuggestOntologyExtension(args: {
  entities_to_analyze?: string[];
  similarity_threshold?: number;
  max_suggestions?: number;
}): Promise<any> {
  log("Suggesting ontology extensions", "info", args);

  const configManager = await getOntologyConfigManager();
  const config = configManager.getConfig();
  const basePath = process.env.KNOWLEDGE_BASE_PATH || process.cwd();

  // Load pending suggestions
  const suggestionsPath = path.join(
    basePath,
    config.autoExtend?.suggestionsPath || '.data/ontologies/suggestions',
    'pending-classes.json'
  );

  let existingSuggestions: any = { pending: [], metadata: { version: '1.0.0', lastUpdated: null } };
  try {
    const content = await fs.readFile(suggestionsPath, 'utf-8');
    existingSuggestions = JSON.parse(content);
  } catch (error) {
    // File might not exist yet
  }

  // Load current entities for analysis if not provided
  let entitiesToAnalyze = args.entities_to_analyze || [];

  if (entitiesToAnalyze.length === 0) {
    // Load entities from knowledge graph export
    try {
      const exportPath = path.join(basePath, '.data/knowledge-export/coding.json');
      const exportContent = await fs.readFile(exportPath, 'utf-8');
      const exportData = JSON.parse(exportContent);

      if (exportData.entities) {
        // Get unique entity types that might need classes
        const entityTypes = new Set<string>();
        for (const entity of exportData.entities) {
          if (entity.type) {
            entityTypes.add(entity.type);
          }
        }
        entitiesToAnalyze = Array.from(entityTypes);
      }
    } catch (error) {
      log("Failed to load entities for analysis", "warning", error);
    }
  }

  // Load current ontology classes for comparison
  const upperPath = path.isAbsolute(config.upperOntologyPath!)
    ? config.upperOntologyPath!
    : path.join(basePath, config.upperOntologyPath!);
  const lowerPath = config.lowerOntologyPath
    ? (path.isAbsolute(config.lowerOntologyPath)
        ? config.lowerOntologyPath
        : path.join(basePath, config.lowerOntologyPath))
    : null;

  const knownClasses = new Set<string>();

  try {
    const upperContent = await fs.readFile(upperPath, 'utf-8');
    const upperOntology = JSON.parse(upperContent);
    if (upperOntology.entityDefinitions) {
      Object.keys(upperOntology.entityDefinitions).forEach(c => knownClasses.add(c.toLowerCase()));
    }
  } catch (error) {
    // Ignore
  }

  if (lowerPath) {
    try {
      const lowerContent = await fs.readFile(lowerPath, 'utf-8');
      const lowerOntology = JSON.parse(lowerContent);
      if (lowerOntology.entityDefinitions) {
        Object.keys(lowerOntology.entityDefinitions).forEach(c => knownClasses.add(c.toLowerCase()));
      }
    } catch (error) {
      // Ignore
    }
  }

  // Find entity types without matching classes
  const unmatchedTypes: string[] = [];
  for (const entityType of entitiesToAnalyze) {
    const normalizedType = entityType.toLowerCase().replace(/[^a-z]/g, '');
    const hasMatch = Array.from(knownClasses).some(cls => {
      const normalizedCls = cls.toLowerCase().replace(/[^a-z]/g, '');
      return normalizedCls === normalizedType ||
             normalizedCls.includes(normalizedType) ||
             normalizedType.includes(normalizedCls);
    });

    if (!hasMatch) {
      unmatchedTypes.push(entityType);
    }
  }

  // Generate suggestions for unmatched types
  const maxSuggestions = args.max_suggestions || 10;
  const newSuggestions: any[] = [];

  for (const entityType of unmatchedTypes.slice(0, maxSuggestions)) {
    // Determine likely parent class based on naming patterns
    let suggestedParent = 'Entity';
    const typeLower = entityType.toLowerCase();

    if (typeLower.includes('pattern') || typeLower.includes('practice')) {
      suggestedParent = 'Pattern';
    } else if (typeLower.includes('insight') || typeLower.includes('observation')) {
      suggestedParent = 'Insight';
    } else if (typeLower.includes('decision') || typeLower.includes('choice')) {
      suggestedParent = 'Decision';
    } else if (typeLower.includes('workflow') || typeLower.includes('process')) {
      suggestedParent = 'Workflow';
    } else if (typeLower.includes('component') || typeLower.includes('module')) {
      suggestedParent = 'SystemComponent';
    } else if (typeLower.includes('config') || typeLower.includes('setting')) {
      suggestedParent = 'ConfigurationData';
    } else if (typeLower.includes('metric') || typeLower.includes('measure')) {
      suggestedParent = 'QualityMetric';
    }

    const suggestion = {
      id: `suggestion-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      suggestedClassName: entityType.replace(/[^a-zA-Z0-9]/g, ''),
      description: `Suggested entity class for "${entityType}" instances`,
      extendsClass: suggestedParent,
      properties: [],
      exampleEntities: [],
      confidence: 0.7,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };

    newSuggestions.push(suggestion);
  }

  // Add new suggestions to existing
  existingSuggestions.pending.push(...newSuggestions);
  existingSuggestions.metadata.lastUpdated = new Date().toISOString();

  // Save updated suggestions
  try {
    const suggestionsDir = path.dirname(suggestionsPath);
    await fs.mkdir(suggestionsDir, { recursive: true });
    await fs.writeFile(suggestionsPath, JSON.stringify(existingSuggestions, null, 2));
  } catch (error) {
    log("Failed to save suggestions", "warning", error);
  }

  // Format response
  let responseText = `# Ontology Extension Suggestions

## Analysis Summary
- **Entity Types Analyzed**: ${entitiesToAnalyze.length}
- **Known Ontology Classes**: ${knownClasses.size}
- **Unmatched Types Found**: ${unmatchedTypes.length}
- **New Suggestions Generated**: ${newSuggestions.length}
- **Total Pending Suggestions**: ${existingSuggestions.pending.length}

`;

  if (newSuggestions.length > 0) {
    responseText += `## New Suggestions\n\n`;
    for (const suggestion of newSuggestions) {
      responseText += `### ${suggestion.suggestedClassName}
- **ID**: ${suggestion.id}
- **Description**: ${suggestion.description}
- **Extends**: ${suggestion.extendsClass}
- **Confidence**: ${(suggestion.confidence * 100).toFixed(0)}%
- **Status**: ${suggestion.status}

`;
    }
  }

  if (unmatchedTypes.length === 0) {
    responseText += `\n✅ All entity types have matching ontology classes.\n`;
  } else {
    responseText += `\n⚠️ ${unmatchedTypes.length} entity types need ontology classes:\n`;
    for (const type of unmatchedTypes.slice(0, 20)) {
      responseText += `- ${type}\n`;
    }
    if (unmatchedTypes.length > 20) {
      responseText += `... and ${unmatchedTypes.length - 20} more\n`;
    }
  }

  responseText += `\n## Next Steps
1. Review pending suggestions in VKB viewer
2. Approve or reject each suggestion
3. Approved classes will be added to the lower ontology
`;

  return {
    content: [{ type: "text", text: responseText }],
    metadata: {
      entities_analyzed: entitiesToAnalyze.length,
      known_classes: knownClasses.size,
      unmatched_types: unmatchedTypes.length,
      new_suggestions: newSuggestions.length,
      total_pending: existingSuggestions.pending.length,
      suggestions: newSuggestions,
    },
  };
}


/**
 * Handle analyze_code_graph tool - AST-based code analysis over the graphify code graph
 */
async function handleAnalyzeCodeGraph(args: {
  action: 'index' | 'query' | 'similar' | 'call_graph' | 'nl_query';
  repository_path?: string;
  query?: string;
  code_snippet?: string;
  entity_name?: string;
  question?: string;
  entity_types?: string[];
  languages?: string[];
  limit?: number;
  depth?: number;
}): Promise<any> {
  log("Analyzing code graph", "info", args);

  const repoPath = args.repository_path || process.env.CODING_TOOLS_PATH || process.cwd();
  const codeGraphAgent = new CodeGraphAgent(repoPath);

  try {
    switch (args.action) {
      case 'index': {
        const result = await codeGraphAgent.indexRepository(args.repository_path);
        return {
          content: [{
            type: "text",
            text: `# Code Graph Index Complete

## Summary
- **Repository**: ${result.repositoryPath}
- **Total Entities**: ${result.statistics.totalEntities}
- **Total Relationships**: ${result.statistics.totalRelationships}
- **Indexed At**: ${result.indexedAt}

## Language Distribution
${Object.entries(result.statistics.languageDistribution)
  .map(([lang, count]) => `- ${lang}: ${count}`)
  .join('\n')}

## Entity Type Distribution
${Object.entries(result.statistics.entityTypeDistribution)
  .map(([type, count]) => `- ${type}: ${count}`)
  .join('\n')}

Source: the graphify service's static graph.json. Rebuild it with \`graphify update\` when it drifts behind HEAD.`
          }],
          metadata: {
            repository_path: result.repositoryPath,
            total_entities: result.statistics.totalEntities,
            total_relationships: result.statistics.totalRelationships,
            indexed_at: result.indexedAt
          }
        };
      }

      case 'query': {
        if (!args.query) {
          throw new Error("Query parameter required for 'query' action");
        }
        const result = await codeGraphAgent.queryCodeGraph(args.query, {
          entityTypes: args.entity_types,
          languages: args.languages,
          limit: args.limit || 20
        });
        return {
          content: [{
            type: "text",
            text: `# Code Graph Query Results

## Query: "${args.query}"
- **Matches Found**: ${result.matches.length}
- **Query Time**: ${result.queryTime}ms

## Results
${result.matches.slice(0, 20).map((entity, i) => 
  `### ${i + 1}. ${entity.name}
- **Type**: ${entity.type}
- **File**: ${entity.filePath}:${entity.lineNumber}
- **Language**: ${entity.language}
${entity.signature ? `- **Signature**: \`${entity.signature}\`` : ''}
`).join('\n')}`
          }],
          metadata: {
            query: args.query,
            matches: result.matches.length,
            query_time: result.queryTime
          }
        };
      }

      case 'similar': {
        if (!args.code_snippet) {
          throw new Error("Code snippet parameter required for 'similar' action");
        }
        const result = await codeGraphAgent.findSimilarCode(args.code_snippet, args.limit || 10);
        return {
          content: [{
            type: "text",
            text: `# Similar Code Results

## Input Snippet
\`\`\`
${args.code_snippet.slice(0, 200)}${args.code_snippet.length > 200 ? '...' : ''}
\`\`\`

## Similar Code Found: ${result.length}

${result.slice(0, 10).map((entity, i) => 
  `### ${i + 1}. ${entity.name}
- **File**: ${entity.filePath}:${entity.lineNumber}
- **Type**: ${entity.type}
`).join('\n')}`
          }],
          metadata: {
            similar_count: result.length
          }
        };
      }

      case 'call_graph': {
        if (!args.entity_name) {
          throw new Error("Entity name parameter required for 'call_graph' action");
        }
        const result = await codeGraphAgent.getCallGraph(args.entity_name, args.depth || 3);
        return {
          content: [{
            type: "text",
            text: `# Call Graph: ${args.entity_name}

## Root Entity
${result.root ? `
- **Name**: ${result.root.name}
- **Type**: ${result.root.type}
- **File**: ${result.root.filePath}:${result.root.lineNumber}
` : 'Not found'}

## Outgoing Calls (${result.calls.length})
${result.calls.slice(0, 20).map(r => `- ${r.source} → ${r.target}`).join('\n')}

## Called By (${result.calledBy.length})
${result.calledBy.slice(0, 20).map(r => `- ${r.source} → ${r.target}`).join('\n')}`
          }],
          metadata: {
            entity: args.entity_name,
            calls: result.calls.length,
            called_by: result.calledBy.length
          }
        };
      }

      case 'nl_query': {
        if (!args.question) {
          throw new Error("Question parameter required for 'nl_query' action");
        }
        const nlResult = await codeGraphAgent.queryNaturalLanguage(args.question);
        return {
          content: [{
            type: "text",
            text: `# Code Graph Natural Language Query

## Question
"${args.question}"

## Generated Cypher
\`\`\`cypher
${nlResult.generatedCypher}
\`\`\`

## Results (${nlResult.results.length} items)
${nlResult.results.length > 0
  ? nlResult.results.slice(0, 25).map((row, i) =>
      `### ${i + 1}. ${JSON.stringify(row)}`
    ).join('\n\n')
  : '*No results found*'
}

---
*Provider: ${nlResult.provider} | Query time: ${nlResult.queryTime}ms*`
          }],
          metadata: {
            question: args.question,
            generated_cypher: nlResult.generatedCypher,
            results_count: nlResult.results.length,
            results: nlResult.results.slice(0, 25),
            provider: nlResult.provider,
            query_time: nlResult.queryTime
          }
        };
      }

      default:
        throw new Error(`Unknown action: ${args.action}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // The graph is a file, not a service, so the failure that matters is a missing
    // or unreadable graph.json -- not a refused connection.
    if (errorMessage.includes('ENOENT') || errorMessage.includes('graph.json')) {
      return {
        content: [{
          type: "text",
          text: `# Code Graph Analysis Failed

**The graphify code graph is missing or unreadable.**

Expected at \`.data/graphify/graphify-out/graph.json\`. Build or refresh it with:

\`\`\`bash
graphify update
\`\`\`

**Error**: ${errorMessage}`
        }],
        isError: true
      };
    }
    
    throw error;
  }
}
