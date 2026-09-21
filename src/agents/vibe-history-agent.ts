import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logging.js';
import { listLslFiles } from '../utils/lsl-discovery.js';
import { CheckpointManager } from '../utils/checkpoint-manager.js';
import { SemanticAnalyzer } from './semantic-analyzer.js';

export interface ConversationSession {
  filename: string;
  timestamp: Date;
  project: string;
  sessionType: string;
  exchanges: ConversationExchange[];
  metadata: {
    sessionId?: string;
    startTime?: Date;
    endTime?: Date;
    totalMessages: number;
    summary?: string;
  };
}

export interface ConversationExchange {
  id: number;
  timestamp: Date;
  userMessage: string;
  assistantMessage: string;
  context: {
    tools: string[];
    files: string[];
    actions: string[];
  };
}

export interface DevelopmentContext {
  problemType: string;
  problemDescription: string;
  solutionApproach: string;
  technicalDetails: string[];
  outcomes: string[];
  session: string;
  timestamp: Date;
}

export interface ProblemSolutionPair {
  problem: {
    description: string;
    context: string;
    difficulty: 'low' | 'medium' | 'high';
  };
  solution: {
    approach: string;
    steps: string[];
    technologies: string[];
    outcome: string;
  };
  metadata: {
    session: string;
    timestamp: Date;
    exchanges: number[];
  };
}

/**
 * Semantic topic extracted from session analysis using LLM
 * Replaces keyword-based problem-solution pairs with meaningful semantic understanding
 */
export interface KeyTopic {
  topic: string;                    // Main topic/theme (e.g., "UKB Workflow Optimization")
  category: 'feature' | 'bugfix' | 'refactoring' | 'infrastructure' | 'documentation' | 'investigation' | 'configuration';
  description: string;              // What was discussed/worked on
  keyDecisions: string[];           // Important decisions made
  technologies: string[];           // Tools/technologies involved
  outcome: 'completed' | 'in_progress' | 'blocked' | 'deferred';
  significance: number;             // 1-10 importance score
  relatedFiles: string[];           // Files mentioned/modified
  sessions: string[];               // Session filenames where this topic appeared
  timespan: {
    first: Date;
    last: Date;
  };
}

export interface VibeHistoryAnalysisResult {
  checkpointInfo: {
    fromTimestamp: Date | null;
    toTimestamp: Date;
    sessionsAnalyzed: number;
  };
  sessions: ConversationSession[];
  developmentContexts: DevelopmentContext[];
  problemSolutionPairs: ProblemSolutionPair[];  // Deprecated - kept for backward compatibility
  keyTopics: KeyTopic[];                         // NEW: Semantic topics extracted via LLM
  patterns: {
    commonProblems: { problem: string; frequency: number }[];
    preferredSolutions: { solution: string; frequency: number }[];
    toolUsage: { tool: string; frequency: number }[];
    developmentThemes: { theme: string; frequency: number }[];
  };
  summary: {
    totalExchanges: number;
    primaryFocus: string;
    keyLearnings: string[];
    insights: string;
    topTopics: string[];  // NEW: Top 5 most significant topics
  };
}

export class VibeHistoryAgent {
  private repositoryPath: string;
  private specstoryPath: string;
  private semanticAnalyzer: SemanticAnalyzer;
  private team: string;
  private checkpointManager: CheckpointManager;

  constructor(repositoryPath: string = '.', team: string = 'coding') {
    this.repositoryPath = repositoryPath;
    this.team = team;
    this.specstoryPath = path.join(repositoryPath, '.specstory', 'history');
    this.semanticAnalyzer = new SemanticAnalyzer();
    this.checkpointManager = new CheckpointManager(repositoryPath);
  }

  async analyzeVibeHistory(fromTimestampOrParams?: Date | Record<string, any>): Promise<VibeHistoryAnalysisResult> {
    // Handle both Date parameter (old API) and parameters object (new coordinator API)
    let fromTimestamp: Date | undefined;
    let checkpointEnabled = true; // Default: use checkpoint filtering
    let maxSessions: number | undefined; // Limit sessions for performance
    let skipLlmEnhancement = false; // Skip LLM call for large datasets

    if (fromTimestampOrParams instanceof Date) {
      fromTimestamp = fromTimestampOrParams;
    } else if (typeof fromTimestampOrParams === 'object' && fromTimestampOrParams !== null) {
      // Parameters object from coordinator - extract timestamp if provided
      if (fromTimestampOrParams.fromTimestamp) {
        fromTimestamp = new Date(fromTimestampOrParams.fromTimestamp);
      }
      // Check if checkpoint filtering should be disabled (for complete-analysis)
      if (fromTimestampOrParams.checkpoint_enabled === false) {
        checkpointEnabled = false;
      }
      // Optional session limit for performance
      if (typeof fromTimestampOrParams.maxSessions === 'number') {
        maxSessions = fromTimestampOrParams.maxSessions;
      }
      // Option to skip LLM enhancement for faster processing
      if (fromTimestampOrParams.skipLlmEnhancement === true) {
        skipLlmEnhancement = true;
      }
    }

    log('Starting vibe history analysis', 'info', {
      repositoryPath: this.repositoryPath,
      specstoryPath: this.specstoryPath,
      fromTimestamp: fromTimestamp?.toISOString() || 'beginning',
      checkpointEnabled,
      maxSessions: maxSessions || 'unlimited',
      skipLlmEnhancement
    });

    try {
      // Validate specstory directory
      this.validateSpecstoryDirectory();

      // Get analysis checkpoint (only if checkpoint filtering is enabled)
      let effectiveFromTimestamp: Date | null = null;
      if (checkpointEnabled) {
        const checkpoint = await this.getLastAnalysisCheckpoint();
        effectiveFromTimestamp = fromTimestamp || checkpoint;
      } else {
        // For complete-analysis: analyze ALL sessions
        effectiveFromTimestamp = fromTimestamp || null;
        log('Checkpoint filtering disabled - analyzing ALL sessions', 'info');
      }

      // Discover and parse session files
      const sessions = await this.parseSessionFiles(effectiveFromTimestamp, maxSessions);
      log(`Parsed ${sessions.length} conversation sessions`, 'info');

      // Extract development contexts
      const developmentContexts = this.extractDevelopmentContexts(sessions);

      // Extract problem-solution pairs using LLM semantic analysis (parallelized)
      const problemSolutionPairs = await this.identifyProblemSolutionPairs(sessions, skipLlmEnhancement);

      // Extract key topics using semantic LLM analysis (parallelized)
      const keyTopics = await this.extractKeyTopics(sessions, skipLlmEnhancement);

      // Analyze patterns
      const patterns = this.analyzePatterns(sessions, developmentContexts, problemSolutionPairs);

      // Generate summary with key topics
      const summary = await this.generateSummary(sessions, developmentContexts, problemSolutionPairs, patterns, skipLlmEnhancement, keyTopics);

      const result: VibeHistoryAnalysisResult = {
        checkpointInfo: {
          fromTimestamp: effectiveFromTimestamp,
          toTimestamp: new Date(),
          sessionsAnalyzed: sessions.length
        },
        sessions,
        developmentContexts,
        problemSolutionPairs,
        keyTopics,
        patterns,
        summary
      };

      // Update checkpoint
      await this.saveAnalysisCheckpoint(new Date());

      log('Vibe history analysis completed', 'info', {
        sessionsAnalyzed: sessions.length,
        contextsExtracted: developmentContexts.length,
        keyTopicsExtracted: keyTopics.length,
        problemSolutionPairs: problemSolutionPairs.length
      });

      return result;

    } catch (error) {
      log('Vibe history analysis failed', 'error', error);
      throw error;
    }
  }

  private validateSpecstoryDirectory(): void {
    if (!fs.existsSync(this.specstoryPath)) {
      throw new Error(`Specstory directory not found: ${this.specstoryPath}`);
    }
  }

  private async getLastAnalysisCheckpoint(): Promise<Date | null> {
    // Use CheckpointManager instead of writing directly to git-tracked JSON
    return this.checkpointManager.getLastVibeAnalysis();
  }

  private async saveAnalysisCheckpoint(timestamp: Date): Promise<void> {
    // Use CheckpointManager instead of writing directly to git-tracked JSON
    this.checkpointManager.setLastVibeAnalysis(timestamp);
  }

  private async parseSessionFiles(fromTimestamp: Date | null, maxSessions?: number): Promise<ConversationSession[]> {
    const sessions: ConversationSession[] = [];
    const PARALLEL_BATCH_SIZE = 20; // Process 20 files in parallel

    try {
      // Newest first, ordered by the timestamp in the filename rather than
      // mtime — a checkout or submodule update rewrites every mtime and would
      // present months-old tranches as the most recent sessions.
      const files = listLslFiles(this.specstoryPath, {
        since: fromTimestamp,
        max: maxSessions && maxSessions > 0 ? maxSessions : undefined,
      });

      log(`Found ${files.length} session files to process (parallel batches of ${PARALLEL_BATCH_SIZE})`, 'info');

      // Process files in parallel batches for performance
      for (let i = 0; i < files.length; i += PARALLEL_BATCH_SIZE) {
        const batch = files.slice(i, i + PARALLEL_BATCH_SIZE);
        const batchNum = Math.floor(i / PARALLEL_BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(files.length / PARALLEL_BATCH_SIZE);

        log(`Processing batch ${batchNum}/${totalBatches} (${batch.length} files)`, 'info');

        const batchResults = await Promise.all(
          batch.map(async (file) => {
            try {
              return await this.parseSessionFile(file.path);
            } catch (error) {
              log(`Failed to parse session file: ${file.name}`, 'warning', error);
              return null;
            }
          })
        );

        // Collect successful parses
        for (const session of batchResults) {
          if (session) {
            sessions.push(session);
          }
        }
      }

      log(`Successfully parsed ${sessions.length} sessions from ${files.length} files`, 'info');

    } catch (error) {
      log('Failed to read specstory directory', 'error', error);
      throw error;
    }

    return sessions;
  }

  /**
   * Extract sessions that correspond to a batch of commits
   * Used by batch processing to correlate vibe sessions with git commits
   *
   * @param startDate - Start date of the batch (from first commit)
   * @param endDate - End date of the batch (from last commit)
   * @returns Sessions that fall within the date range
   */
  async extractSessionsForDateRange(
    startDate: Date,
    endDate: Date
  ): Promise<ConversationSession[]> {
    const sessions: ConversationSession[] = [];
    const PARALLEL_BATCH_SIZE = 20;

    try {
      // Oldest first, bounded by the requested range. The filename carries the
      // authoritative start instant, so no stat() is needed to date a session.
      const files = listLslFiles(this.specstoryPath, {
        since: startDate,
        until: endDate,
        order: 'oldest',
      });

      log(`Found ${files.length} session files for date range`, 'info', {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        fileCount: files.length
      });

      if (files.length === 0) {
        return [];
      }

      // Process files in parallel batches
      for (let i = 0; i < files.length; i += PARALLEL_BATCH_SIZE) {
        const batch = files.slice(i, i + PARALLEL_BATCH_SIZE);

        const batchResults = await Promise.all(
          batch.map(async (file) => {
            try {
              return await this.parseSessionFile(file.path);
            } catch (error) {
              log(`Failed to parse session file: ${file.name}`, 'warning', error);
              return null;
            }
          })
        );

        for (const session of batchResults) {
          if (session) {
            sessions.push(session);
          }
        }
      }

      log(`Extracted ${sessions.length} sessions for date range`, 'info');
      return sessions;

    } catch (error) {
      log('Failed to extract sessions for date range', 'error', error);
      return [];
    }
  }

  /**
   * Extract sessions that correlate with specific commits
   * Uses commit timestamps to find relevant vibe sessions
   *
   * @param commits - Array of commits with date information
   * @returns Sessions correlated with the commits
   */
  async extractSessionsForCommits(
    commits: Array<{ date: Date; hash: string; message: string }>
  ): Promise<{
    sessions: ConversationSession[];
    correlations: Array<{
      sessionFilename: string;
      relatedCommits: string[];
    }>;
  }> {
    if (commits.length === 0) {
      return { sessions: [], correlations: [] };
    }

    // Get date range from commits with buffer for session overlap
    const commitDates = commits.map(c => c.date.getTime());
    const minDate = new Date(Math.min(...commitDates));
    const maxDate = new Date(Math.max(...commitDates));

    // Add buffer: sessions might start before first commit or end after last
    const bufferMs = 2 * 60 * 60 * 1000; // 2 hours
    const startDate = new Date(minDate.getTime() - bufferMs);
    const endDate = new Date(maxDate.getTime() + bufferMs);

    // Extract sessions in the date range
    const sessions = await this.extractSessionsForDateRange(startDate, endDate);

    // Build correlations: map sessions to related commits
    const correlations: Array<{ sessionFilename: string; relatedCommits: string[] }> = [];

    for (const session of sessions) {
      const sessionStart = session.timestamp;
      const sessionEnd = session.metadata?.endTime
        ? new Date(session.metadata.endTime)
        : new Date(sessionStart.getTime() + 60 * 60 * 1000); // Default 1 hour

      // Find commits that fall within this session's timeframe
      const relatedCommits = commits
        .filter(commit => {
          const commitTime = commit.date.getTime();
          return commitTime >= sessionStart.getTime() &&
                 commitTime <= sessionEnd.getTime();
        })
        .map(c => c.hash);

      if (relatedCommits.length > 0) {
        correlations.push({
          sessionFilename: session.filename,
          relatedCommits
        });
      }
    }

    log('Correlated sessions with commits', 'info', {
      sessionCount: sessions.length,
      correlationCount: correlations.length,
      commitCount: commits.length
    });

    return { sessions, correlations };
  }

  /**
   * Extract date from LSL filename format
   * Filename format: YYYY-MM-DD_HHMM-HHMM_hash.md
   */
  private extractDateFromFilename(filename: string): Date | null {
    const match = filename.match(/^(\d{4}-\d{2}-\d{2})_(\d{4})-(\d{4})/);
    if (match) {
      const [, date, startTime] = match;
      const hour = startTime.substring(0, 2);
      const minute = startTime.substring(2, 4);
      return new Date(`${date}T${hour}:${minute}:00`);
    }
    return null;
  }

  /**
   * Get estimated token count for sessions
   * Used by batch scheduler to estimate processing cost
   */
  estimateSessionTokens(sessions: ConversationSession[]): number {
    let totalTokens = 0;

    for (const session of sessions) {
      // Estimate tokens for metadata
      totalTokens += 50; // filename, timestamps, etc.

      // Estimate tokens for exchanges
      for (const exchange of session.exchanges) {
        if (exchange.userMessage) {
          totalTokens += Math.ceil(exchange.userMessage.length / 4);
        }
        if (exchange.assistantMessage) {
          totalTokens += Math.ceil(exchange.assistantMessage.length / 4);
        }
      }
    }

    return totalTokens;
  }

  private async parseSessionFile(filePath: string): Promise<ConversationSession | null> {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const filename = path.basename(filePath);
      
      // Extract metadata from filename and content
      const metadata = this.extractSessionMetadata(filename, content);
      if (!metadata) return null;

      // Parse exchanges
      const exchanges = this.parseExchanges(content);

      return {
        filename,
        timestamp: metadata.timestamp,
        project: metadata.project,
        sessionType: metadata.sessionType,
        exchanges,
        metadata: {
          sessionId: metadata.sessionId,
          startTime: metadata.startTime,
          endTime: metadata.endTime,
          totalMessages: metadata.totalMessages || exchanges.length * 2,
          summary: metadata.summary
        }
      };

    } catch (error) {
      log(`Error parsing session file: ${filePath}`, 'error', error);
      return null;
    }
  }

  private extractSessionMetadata(filename: string, content: string): any {
    // Parse filename: YYYY-MM-DD_HHMM-HHMM_hash.md (LSL format)
    // Also support legacy format: YYYY-MM-DD_HH-MM-SS_project-session.md
    // Accept both LSL extensions: pi-format `.jsonl` (current) and legacy `.md`.
    const lslMatch = filename.match(/^(\d{4}-\d{2}-\d{2})_(\d{4})-(\d{4})_(.+)\.(?:jsonl|md)$/);
    const legacyMatch = filename.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})_(.+)-session\.md$/);

    let datePart, startTime, endTime, identifier, timestamp;

    if (lslMatch) {
      // LSL format: YYYY-MM-DD_HHMM-HHMM_hash.md
      [, datePart, startTime, endTime, identifier] = lslMatch;
      // Convert HHMM to HH:MM
      const startHHMM = `${startTime.slice(0, 2)}:${startTime.slice(2)}`;
      timestamp = new Date(`${datePart}T${startHHMM}:00`);
    } else if (legacyMatch) {
      // Legacy format: YYYY-MM-DD_HH-MM-SS_project-session.md
      const timePart = legacyMatch[2];
      datePart = legacyMatch[1];
      identifier = legacyMatch[3];
      timestamp = new Date(`${datePart}T${timePart.replace(/-/g, ':')}:00`);
    } else {
      log(`Invalid session filename format: ${filename}`, 'warning');
      return null;
    }

    // Extract metadata from content
    const sessionIdMatch = content.match(/\*\*Session ID:\*\* ([^\s\n]+)/);
    const summaryMatch = content.match(/\*\*Summary:\*\* ([^\n]+)/);
    const startTimeMatch = content.match(/\*\*Start Time:\*\* ([^\n]+)/);
    const endTimeMatch = content.match(/\*\*End Time:\*\* ([^\n]+)/);
    const totalMessagesMatch = content.match(/\*\*Total Messages:\*\* (\d+)/);

    return {
      timestamp,
      project: identifier.replace(/_/g, ' ').replace(/-/g, ' '),
      sessionType: 'development',
      sessionId: sessionIdMatch?.[1],
      summary: summaryMatch?.[1],
      startTime: startTimeMatch ? new Date(startTimeMatch[1]) : timestamp,
      endTime: endTimeMatch ? new Date(endTimeMatch[1]) : timestamp,
      totalMessages: totalMessagesMatch ? parseInt(totalMessagesMatch[1], 10) : undefined
    };
  }

  private parseExchanges(content: string): ConversationExchange[] {
    const exchanges: ConversationExchange[] = [];

    // LSL format uses "## Prompt Set" sections containing multiple interactions
    // Each Prompt Set can have:
    // - "### Text Exchange - TIMESTAMP" with "**User Message:**"
    // - "### ToolName - TIMESTAMP" with "**User Request:**", "**Tool:**", "**Result:**"

    // First try LSL format (## Prompt Set)
    // Handle both old format "## Prompt Set 1 (ps_...)" and new format "## Prompt Set (ps_...)"
    const promptSetSections = content.split(/## Prompt Set (?:\d+ )?\([^)]+\)/).slice(1);

    if (promptSetSections.length > 0) {
      // LSL format detected
      let exchangeId = 1;
      for (const promptSet of promptSetSections) {
        const parsedExchanges = this.parseLslPromptSet(promptSet, exchangeId);
        exchanges.push(...parsedExchanges);
        exchangeId += parsedExchanges.length;
      }
    } else {
      // Fallback to legacy format (## Exchange \d+)
      const exchangeSections = content.split(/## Exchange \d+/).slice(1);
      for (let i = 0; i < exchangeSections.length; i++) {
        try {
          const section = exchangeSections[i];
          const exchange = this.parseLegacyExchange(i + 1, section);
          if (exchange) {
            exchanges.push(exchange);
          }
        } catch (error) {
          log(`Error parsing exchange ${i + 1}`, 'warning', error);
        }
      }
    }

    return exchanges;
  }

  /**
   * Parse LSL format Prompt Set section
   * Contains "### Text Exchange" for user messages and "### ToolName" for tool calls
   * Also handles older format with "### User" / "### Assistant" sections
   */
  private parseLslPromptSet(promptSet: string, startId: number): ConversationExchange[] {
    const exchanges: ConversationExchange[] = [];
    let id = startId;

    // NEW FORMAT: Find all Text Exchange sections (actual user conversations)
    const textExchangeRegex = /### Text Exchange - ([^\n]+)\n\n\*\*User Message:\*\* ([\s\S]*?)(?=\n\n\*\*|\n---|\n### |\n## |$)/g;
    let match;

    while ((match = textExchangeRegex.exec(promptSet)) !== null) {
      const timestampStr = match[1];
      const userMessage = match[2].trim();

      // Parse timestamp from format "2025-12-20 06:50:12 UTC [07:50:12 CEST]"
      const timestamp = this.parseTimestamp(timestampStr);

      // Look for tool calls that follow this user message (assistant response)
      const toolCalls = this.extractToolCallsFromPromptSet(promptSet);
      const assistantMessage = this.buildAssistantMessageFromToolCalls(toolCalls);

      exchanges.push({
        id: id++,
        timestamp,
        userMessage,
        assistantMessage,
        context: {
          tools: toolCalls.map(t => t.tool),
          files: this.extractFilesFromToolCalls(toolCalls),
          actions: this.extractActionsFromMessage(userMessage)
        }
      });
    }

    // OLD FORMAT: Handle "### User" / "### Assistant" sections (older LSL format)
    // In old format: first ### User is the user request, subsequent ### User are tool results
    if (exchanges.length === 0) {
      // Find the FIRST ### User section (the actual user request)
      // Subsequent ### User sections contain tool results (start with **Result:**)
      const firstUserMatch = promptSet.match(/### User\n\n([\s\S]*?)(?=\n### Assistant|\n### User|\n## |$)/);
      if (firstUserMatch) {
        const userMessage = firstUserMatch[1].trim();
        // Only process if it's not a tool result
        if (!userMessage.startsWith('**Result:**')) {
          // Find the first assistant response
          const assistantMatch = promptSet.match(/### Assistant\n\n([\s\S]*?)(?=\n### User|\n### Assistant|\n## |$)/);
          const assistantMessage = assistantMatch ? assistantMatch[1].trim() : '';

          // Extract tool calls from the full prompt set for context
          const toolCalls = this.extractToolCallsFromPromptSet(promptSet);

          exchanges.push({
            id: id++,
            timestamp: new Date(), // Old format doesn't have per-message timestamps
            userMessage,
            assistantMessage,
            context: {
              tools: toolCalls.map(t => t.tool),
              files: this.extractFilesFromToolCalls(toolCalls),
              actions: this.extractActionsFromMessage(userMessage)
            }
          });
        }
      }
    }

    // If still no exchanges found, check for tool-only prompt sets (user sent image/continued)
    if (exchanges.length === 0) {
      const toolCalls = this.extractToolCallsFromPromptSet(promptSet);
      if (toolCalls.length > 0) {
        // Extract user request from first tool call if available
        const firstToolWithRequest = toolCalls.find(t => t.userRequest);
        const userMessage = firstToolWithRequest?.userRequest || '[Image or continuation]';

        exchanges.push({
          id: startId,
          timestamp: toolCalls[0]?.timestamp || new Date(),
          userMessage,
          assistantMessage: this.buildAssistantMessageFromToolCalls(toolCalls),
          context: {
            tools: toolCalls.map(t => t.tool),
            files: this.extractFilesFromToolCalls(toolCalls),
            actions: this.extractActionsFromToolCalls(toolCalls)
          }
        });
      }
    }

    return exchanges;
  }

  private parseTimestamp(timestampStr: string): Date {
    // Format: "2025-12-20 06:50:12 UTC [07:50:12 CEST]" or "2025-12-20 06:50:12 UTC"
    const cleanStr = timestampStr.split(' [')[0].replace(' UTC', 'Z').replace(' ', 'T');
    const parsed = new Date(cleanStr);
    return isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  private extractToolCallsFromPromptSet(promptSet: string): Array<{tool: string; timestamp: Date; result: string; output?: string; userRequest?: string}> {
    const toolCalls: Array<{tool: string; timestamp: Date; result: string; output?: string; userRequest?: string}> = [];

    // Match tool sections: ### ToolName - TIMESTAMP
    const toolSectionRegex = /### ([A-Za-z_]+) - ([^\n]+)\n\n([\s\S]*?)(?=\n---\n|\n### |\n## |$)/g;
    let match;

    while ((match = toolSectionRegex.exec(promptSet)) !== null) {
      const toolName = match[1];
      if (toolName === 'Text') continue; // Skip "Text Exchange" sections

      const timestampStr = match[2];
      const toolContent = match[3];

      // Extract result status
      const resultMatch = toolContent.match(/\*\*Result:\*\* (✅ Success|❌ Error)/);
      const result = resultMatch ? resultMatch[1] : 'unknown';

      // Extract output if present
      const outputMatch = toolContent.match(/\*\*Output:\*\* ```[^\n]*\n([\s\S]*?)```/);
      const output = outputMatch ? outputMatch[1].trim() : undefined;

      // Extract user request
      const userRequestMatch = toolContent.match(/\*\*User Request:\*\* ([\s\S]*?)(?=\n\*\*Tool:\*\*|\n\*\*Input:\*\*|$)/);
      const userRequest = userRequestMatch ? userRequestMatch[1].trim() : undefined;

      toolCalls.push({
        tool: toolName,
        timestamp: this.parseTimestamp(timestampStr),
        result,
        output,
        userRequest
      });
    }

    return toolCalls;
  }

  private buildAssistantMessageFromToolCalls(toolCalls: Array<{tool: string; result: string; output?: string}>): string {
    if (toolCalls.length === 0) return '';

    const parts: string[] = [];
    for (const call of toolCalls.slice(0, 10)) { // Limit to first 10 for reasonable size
      parts.push(`[Tool: ${call.tool}] ${call.result}`);
      if (call.output) {
        parts.push(call.output.substring(0, 200)); // Truncate long outputs
      }
    }
    return parts.join('\n');
  }

  private extractFilesFromToolCalls(toolCalls: Array<{output?: string}>): string[] {
    const files: string[] = [];
    for (const call of toolCalls) {
      if (call.output) {
        const fileMatches = call.output.match(/[\w\-./]+\.(ts|js|json|md|py|txt|yml|yaml|tsx|jsx)\b/g);
        if (fileMatches) {
          fileMatches.forEach(f => {
            if (!files.includes(f)) files.push(f);
          });
        }
      }
    }
    return files.slice(0, 20);
  }

  private extractActionsFromToolCalls(toolCalls: Array<{tool: string}>): string[] {
    const actions: string[] = [];
    const toolToAction: Record<string, string> = {
      'Edit': 'update',
      'Write': 'create',
      'Read': 'analyze',
      'Bash': 'execute',
      'Grep': 'search',
      'Glob': 'search',
      'TodoWrite': 'plan'
    };

    for (const call of toolCalls) {
      const action = toolToAction[call.tool];
      if (action && !actions.includes(action)) {
        actions.push(action);
      }
    }
    return actions;
  }

  private extractActionsFromMessage(message: string): string[] {
    const actions: string[] = [];
    const actionPatterns = [
      { pattern: /creating?|create/i, action: 'create' },
      { pattern: /updating?|update/i, action: 'update' },
      { pattern: /fixing?|fix/i, action: 'fix' },
      { pattern: /analyzing?|analyze/i, action: 'analyze' },
      { pattern: /implementing?|implement/i, action: 'implement' },
      { pattern: /refactoring?|refactor/i, action: 'refactor' },
      { pattern: /debug/i, action: 'debug' },
      { pattern: /test/i, action: 'test' }
    ];

    for (const { pattern, action } of actionPatterns) {
      if (pattern.test(message) && !actions.includes(action)) {
        actions.push(action);
      }
    }
    return actions;
  }

  /**
   * Legacy format parser for backwards compatibility
   */
  private parseLegacyExchange(id: number, section: string): ConversationExchange | null {
    try {
      // Extract user message
      const userMatch = section.match(/\*\*User:\*\* \*\(([^)]+)\)\*\n([\s\S]*?)(?=\n\*\*Assistant:\*\*|\n---|\n## Exchange|\n\*\*Extraction Summary|\nEOF|$)/);
      if (!userMatch) return null;

      const timestamp = new Date(userMatch[1]);
      const userMessage = userMatch[2].trim();

      // Extract assistant message
      const assistantMatch = section.match(/\*\*Assistant:\*\* \*\(([^)]+)\)\*\n([\s\S]*?)(?=\n---|\n## Exchange|\n\*\*Extraction Summary|\nEOF|$)/);
      const assistantMessage = assistantMatch ? assistantMatch[2].trim() : '';

      // Extract context (tools, files, actions)
      const context = this.extractExchangeContext(userMessage, assistantMessage);

      return {
        id,
        timestamp,
        userMessage,
        assistantMessage,
        context
      };

    } catch (error) {
      log(`Error parsing exchange content`, 'warning', error);
      return null;
    }
  }

  private extractExchangeContext(userMessage: string, assistantMessage: string): ConversationExchange['context'] {
    const tools: string[] = [];
    const files: string[] = [];
    const actions: string[] = [];

    // Extract tool usage
    const toolMatches = assistantMessage.match(/\[Tool: ([^\]]+)\]/g);
    if (toolMatches) {
      toolMatches.forEach(match => {
        const tool = match.replace(/\[Tool: ([^\]]+)\]/, '$1');
        if (!tools.includes(tool)) tools.push(tool);
      });
    }

    // Extract file references
    const fileMatches = [...userMessage, assistantMessage].join(' ').match(/[\w\-./]+\.(ts|js|json|md|py|txt|yml|yaml)\b/g);
    if (fileMatches) {
      fileMatches.forEach(file => {
        if (!files.includes(file)) files.push(file);
      });
    }

    // Extract actions from common patterns
    const actionPatterns = [
      { pattern: /creating?|create/i, action: 'create' },
      { pattern: /updating?|update/i, action: 'update' },
      { pattern: /fixing?|fix/i, action: 'fix' },
      { pattern: /analyzing?|analyze/i, action: 'analyze' },
      { pattern: /implementing?|implement/i, action: 'implement' },
      { pattern: /refactoring?|refactor/i, action: 'refactor' },
      { pattern: /testing?|test/i, action: 'test' },
      { pattern: /debugging?|debug/i, action: 'debug' }
    ];

    const combinedText = userMessage + ' ' + assistantMessage;
    actionPatterns.forEach(({ pattern, action }) => {
      if (pattern.test(combinedText) && !actions.includes(action)) {
        actions.push(action);
      }
    });

    return { tools, files, actions };
  }

  private extractDevelopmentContexts(sessions: ConversationSession[]): DevelopmentContext[] {
    const contexts: DevelopmentContext[] = [];

    for (const session of sessions) {
      // Group related exchanges into contexts
      let currentContext: Partial<DevelopmentContext> | null = null;
      let contextExchanges: ConversationExchange[] = [];

      for (const exchange of session.exchanges) {
        // Check if this exchange starts a new development context
        if (this.isContextStart(exchange)) {
          // Save previous context if exists
          if (currentContext && contextExchanges.length > 0) {
            const context = this.buildDevelopmentContext(currentContext, contextExchanges, session);
            if (context) contexts.push(context);
          }

          // Start new context
          currentContext = {
            session: session.filename,
            timestamp: exchange.timestamp
          };
          contextExchanges = [exchange];
        } else if (currentContext) {
          contextExchanges.push(exchange);
        }
      }

      // Handle final context
      if (currentContext && contextExchanges.length > 0) {
        const context = this.buildDevelopmentContext(currentContext, contextExchanges, session);
        if (context) contexts.push(context);
      }
    }

    return contexts;
  }

  private isContextStart(exchange: ConversationExchange): boolean {
    const userMessage = exchange.userMessage.toLowerCase();
    const startPatterns = [
      'help me', 'i need to', 'how do i', 'can you', 'implement',
      'create', 'fix', 'debug', 'analyze', 'review'
    ];

    return startPatterns.some(pattern => userMessage.includes(pattern));
  }

  private buildDevelopmentContext(
    partial: Partial<DevelopmentContext>,
    exchanges: ConversationExchange[],
    session: ConversationSession
  ): DevelopmentContext | null {
    if (exchanges.length === 0) return null;

    const firstExchange = exchanges[0];
    const allText = exchanges.map(e => e.userMessage + ' ' + e.assistantMessage).join(' ');

    // Determine problem type
    const problemType = this.identifyProblemType(allText);
    
    // Extract problem description
    const problemDescription = firstExchange.userMessage.split('\n')[0].trim();

    // Extract solution approach
    const solutionApproach = this.extractSolutionApproach(exchanges);

    // Extract technical details
    const technicalDetails = this.extractTechnicalDetails(exchanges);

    // Extract outcomes
    const outcomes = this.extractOutcomes(exchanges);

    return {
      problemType,
      problemDescription,
      solutionApproach,
      technicalDetails,
      outcomes,
      session: session.filename,
      timestamp: partial.timestamp || firstExchange.timestamp
    };
  }

  private identifyProblemType(text: string): string {
    const problemTypes = [
      { type: 'Bug Fix', keywords: ['bug', 'error', 'issue', 'problem', 'broken', 'fail'] },
      { type: 'Feature Implementation', keywords: ['implement', 'feature', 'add', 'create', 'new'] },
      { type: 'Refactoring', keywords: ['refactor', 'improve', 'optimize', 'cleanup', 'restructure'] },
      { type: 'Configuration', keywords: ['config', 'setup', 'install', 'configure'] },
      { type: 'Analysis', keywords: ['analyze', 'review', 'investigate', 'understand'] },
      { type: 'Testing', keywords: ['test', 'spec', 'verification', 'validate'] }
    ];

    const lowerText = text.toLowerCase();
    for (const { type, keywords } of problemTypes) {
      if (keywords.some(keyword => lowerText.includes(keyword))) {
        return type;
      }
    }

    return 'General Development';
  }

  private extractSolutionApproach(exchanges: ConversationExchange[]): string {
    // Look for assistant's first substantial response
    for (const exchange of exchanges) {
      if (exchange.assistantMessage.length > 100) {
        // Extract first paragraph or sentence
        const sentences = exchange.assistantMessage.split(/[.!?]+/);
        return sentences[0]?.trim() + '.' || '';
      }
    }
    return 'Solution approach not clearly documented';
  }

  private extractTechnicalDetails(exchanges: ConversationExchange[]): string[] {
    const details: string[] = [];
    
    exchanges.forEach(exchange => {
      // Extract technical terms
      const technicalTerms = exchange.assistantMessage.match(/`[^`]+`/g);
      if (technicalTerms) {
        technicalTerms.forEach(term => {
          const clean = term.replace(/`/g, '');
          if (!details.includes(clean)) details.push(clean);
        });
      }

      // Extract tools used
      exchange.context.tools.forEach(tool => {
        if (!details.includes(`Tool: ${tool}`)) {
          details.push(`Tool: ${tool}`);
        }
      });
    });

    return details.slice(0, 10); // Limit to top 10
  }

  private extractOutcomes(exchanges: ConversationExchange[]): string[] {
    const outcomes: string[] = [];
    const lastExchange = exchanges[exchanges.length - 1];
    
    if (lastExchange?.assistantMessage) {
      // Look for success indicators
      const successPatterns = [
        /successfully? (created|implemented|fixed|updated|completed)/gi,
        /✅.*$/gm,
        /(done|finished|completed|ready)/gi
      ];

      successPatterns.forEach(pattern => {
        const matches = lastExchange.assistantMessage.match(pattern);
        if (matches) {
          matches.forEach(match => {
            if (!outcomes.includes(match.trim())) {
              outcomes.push(match.trim());
            }
          });
        }
      });
    }

    return outcomes.slice(0, 5);
  }

  /**
   * Extract key topics from sessions using semantic LLM analysis
   * Groups sessions into batches and processes them in parallel for efficiency
   */
  private async extractKeyTopics(sessions: ConversationSession[], skipLlm: boolean = false): Promise<KeyTopic[]> {
    if (sessions.length === 0) return [];

    // If skipping LLM, return empty (fall back to keyword-based problemSolutionPairs)
    if (skipLlm) {
      log('Skipping LLM topic extraction (skipLlmEnhancement=true)', 'info');
      return [];
    }

    const BATCH_SIZE = 15;  // Sessions per batch for LLM analysis
    const PARALLEL_BATCHES = 3;  // Process 3 batches in parallel
    const allTopics: KeyTopic[] = [];

    // Sort sessions by date for chronological grouping
    const sortedSessions = [...sessions].sort((a, b) =>
      a.timestamp.getTime() - b.timestamp.getTime()
    );

    // Create batches
    const batches: ConversationSession[][] = [];
    for (let i = 0; i < sortedSessions.length; i += BATCH_SIZE) {
      batches.push(sortedSessions.slice(i, i + BATCH_SIZE));
    }

    log(`Extracting key topics from ${sessions.length} sessions in ${batches.length} batches`, 'info');

    // Process batches in parallel chunks
    for (let chunkStart = 0; chunkStart < batches.length; chunkStart += PARALLEL_BATCHES) {
      const chunk = batches.slice(chunkStart, chunkStart + PARALLEL_BATCHES);

      const batchPromises = chunk.map(async (batch, idx) => {
        try {
          return await this.extractTopicsFromBatch(batch, chunkStart + idx);
        } catch (error) {
          log(`Failed to extract topics from batch ${chunkStart + idx}`, 'warning', error);
          return [];
        }
      });

      const batchResults = await Promise.all(batchPromises);
      for (const topics of batchResults) {
        allTopics.push(...topics);
      }
    }

    // Merge similar topics across batches
    const mergedTopics = this.mergeSimiLarTopics(allTopics);

    // Sort by significance and return top topics
    mergedTopics.sort((a, b) => b.significance - a.significance);

    log(`Extracted ${mergedTopics.length} unique key topics`, 'info');
    return mergedTopics.slice(0, 50);  // Return top 50 topics
  }

  /**
   * Extract topics from a single batch of sessions using LLM
   */
  private async extractTopicsFromBatch(sessions: ConversationSession[], batchIndex: number): Promise<KeyTopic[]> {
    // Create condensed representation of sessions for LLM
    const sessionSummaries = sessions.map(session => {
      const exchanges = session.exchanges.slice(0, 5);  // First 5 exchanges per session
      const userMessages = exchanges.map(e => e.userMessage).filter(m => m.length > 10);
      const files = [...new Set(exchanges.flatMap(e => e.context.files))].slice(0, 10);
      const tools = [...new Set(exchanges.flatMap(e => e.context.tools))].slice(0, 10);

      return {
        date: session.timestamp.toISOString().split('T')[0],
        filename: session.filename,
        messages: userMessages.slice(0, 3).map(m => m.substring(0, 200)),
        files,
        tools
      };
    });

    const prompt = `Analyze these development session summaries and extract the KEY TOPICS discussed.
For each topic, identify:
- What was being worked on (main topic/theme)
- Category: feature, bugfix, refactoring, infrastructure, documentation, investigation, or configuration
- Key decisions made
- Technologies/tools involved
- Outcome: completed, in_progress, blocked, or deferred
- Significance (1-10, where 10 = critical architectural change)

Sessions (batch ${batchIndex + 1}):
${JSON.stringify(sessionSummaries, null, 2)}

Return a JSON array of topics:
[{
  "topic": "Short topic name",
  "category": "feature|bugfix|refactoring|infrastructure|documentation|investigation|configuration",
  "description": "What was discussed/worked on",
  "keyDecisions": ["decision1", "decision2"],
  "technologies": ["tech1", "tech2"],
  "outcome": "completed|in_progress|blocked|deferred",
  "significance": 7,
  "relatedFiles": ["file1.ts", "file2.ts"]
}]

Focus on SUBSTANTIVE development topics. Ignore trivial commands like "sl" or simple queries.
Return 3-8 topics per batch. Return ONLY the JSON array, no other text.`;

    try {
      const result = await this.semanticAnalyzer.analyzeContent(prompt, {
        analysisType: "patterns",
        provider: "auto"
      });

      // Parse LLM response - insights is the string response
      const jsonMatch = result.insights.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        log(`No JSON array found in LLM response for batch ${batchIndex}`, 'warning');
        return [];
      }

      const topics = JSON.parse(jsonMatch[0]) as Array<{
        topic: string;
        category: string;
        description: string;
        keyDecisions: string[];
        technologies: string[];
        outcome: string;
        significance: number;
        relatedFiles: string[];
      }>;

      // Transform to KeyTopic format with session metadata
      const sessionFilenames = sessions.map(s => s.filename);
      const timespan = {
        first: sessions[0].timestamp,
        last: sessions[sessions.length - 1].timestamp
      };

      return topics.map(t => ({
        topic: t.topic,
        category: (t.category as KeyTopic['category']) || 'investigation',
        description: t.description,
        keyDecisions: t.keyDecisions || [],
        technologies: t.technologies || [],
        outcome: (t.outcome as KeyTopic['outcome']) || 'in_progress',
        significance: Math.min(10, Math.max(1, t.significance || 5)),
        relatedFiles: t.relatedFiles || [],
        sessions: sessionFilenames,
        timespan
      }));

    } catch (error) {
      log(`LLM topic extraction failed for batch ${batchIndex}`, 'warning', error);
      return [];
    }
  }

  /**
   * Merge similar topics across batches based on topic name similarity
   */
  private mergeSimiLarTopics(topics: KeyTopic[]): KeyTopic[] {
    if (topics.length === 0) return [];

    const merged: KeyTopic[] = [];
    const processed = new Set<number>();

    for (let i = 0; i < topics.length; i++) {
      if (processed.has(i)) continue;

      const current = topics[i];
      const similar: KeyTopic[] = [current];
      processed.add(i);

      // Find similar topics (simple word overlap for now)
      const currentWords = new Set(current.topic.toLowerCase().split(/\s+/));

      for (let j = i + 1; j < topics.length; j++) {
        if (processed.has(j)) continue;

        const other = topics[j];
        const otherWords = new Set(other.topic.toLowerCase().split(/\s+/));

        // Calculate word overlap
        const intersection = [...currentWords].filter(w => otherWords.has(w) && w.length > 3);
        const similarity = intersection.length / Math.max(currentWords.size, otherWords.size);

        if (similarity > 0.4 || current.topic.toLowerCase().includes(other.topic.toLowerCase()) ||
            other.topic.toLowerCase().includes(current.topic.toLowerCase())) {
          similar.push(other);
          processed.add(j);
        }
      }

      // Merge similar topics
      if (similar.length === 1) {
        merged.push(current);
      } else {
        // Take highest significance topic as base
        similar.sort((a, b) => b.significance - a.significance);
        const base = similar[0];

        merged.push({
          topic: base.topic,
          category: base.category,
          description: base.description,
          keyDecisions: [...new Set(similar.flatMap(t => t.keyDecisions))].slice(0, 10),
          technologies: [...new Set(similar.flatMap(t => t.technologies))].slice(0, 10),
          outcome: base.outcome,
          significance: Math.max(...similar.map(t => t.significance)),
          relatedFiles: [...new Set(similar.flatMap(t => t.relatedFiles))].slice(0, 20),
          sessions: [...new Set(similar.flatMap(t => t.sessions))],
          timespan: {
            first: new Date(Math.min(...similar.map(t => t.timespan.first.getTime()))),
            last: new Date(Math.max(...similar.map(t => t.timespan.last.getTime())))
          }
        });
      }
    }

    return merged;
  }

  /**
   * Extract problem/solution pairs using LLM semantic analysis.
   * This replaces the legacy keyword-based detection with proper semantic understanding.
   */
  private async identifyProblemSolutionPairs(sessions: ConversationSession[], skipLlm: boolean = false): Promise<ProblemSolutionPair[]> {
    if (sessions.length === 0) return [];

    // If skipping LLM, return empty array (no fallback to broken keyword matching)
    if (skipLlm) {
      log('Skipping LLM problem/solution extraction (skipLlmEnhancement=true)', 'info');
      return [];
    }

    const BATCH_SIZE = 10;  // Sessions per batch
    const PARALLEL_BATCHES = 3;
    const allPairs: ProblemSolutionPair[] = [];

    // Sort sessions chronologically
    const sortedSessions = [...sessions].sort((a, b) =>
      a.timestamp.getTime() - b.timestamp.getTime()
    );

    // Create batches
    const batches: ConversationSession[][] = [];
    for (let i = 0; i < sortedSessions.length; i += BATCH_SIZE) {
      batches.push(sortedSessions.slice(i, i + BATCH_SIZE));
    }

    log(`Extracting problem/solution pairs from ${sessions.length} sessions in ${batches.length} batches`, 'info');

    // Process batches in parallel chunks
    for (let chunkStart = 0; chunkStart < batches.length; chunkStart += PARALLEL_BATCHES) {
      const chunk = batches.slice(chunkStart, chunkStart + PARALLEL_BATCHES);

      const batchPromises = chunk.map(async (batch, idx) => {
        try {
          return await this.extractProblemSolutionPairsFromBatch(batch, chunkStart + idx);
        } catch (error) {
          log(`Failed to extract problem/solution pairs from batch ${chunkStart + idx}`, 'warning', error);
          return [];
        }
      });

      const batchResults = await Promise.all(batchPromises);
      for (const pairs of batchResults) {
        allPairs.push(...pairs);
      }
    }

    log(`Extracted ${allPairs.length} problem/solution pairs via LLM`, 'info');
    return allPairs;
  }

  /**
   * Extract problem/solution pairs from a batch of sessions using LLM semantic analysis.
   */
  private async extractProblemSolutionPairsFromBatch(sessions: ConversationSession[], batchIndex: number): Promise<ProblemSolutionPair[]> {
    // Create condensed representation for LLM
    const sessionSummaries = sessions.map(session => {
      const exchanges = session.exchanges.slice(0, 8);  // First 8 exchanges
      const userMessages = exchanges.map(e => e.userMessage).filter(m => m.length > 20);
      const assistantMessages = exchanges.map(e => e.assistantMessage).filter(m => m.length > 50);
      const files = [...new Set(exchanges.flatMap(e => e.context.files))].slice(0, 15);
      const tools = [...new Set(exchanges.flatMap(e => e.context.tools))].slice(0, 10);

      return {
        date: session.timestamp.toISOString().split('T')[0],
        filename: session.filename,
        userRequests: userMessages.slice(0, 5).map(m => m.substring(0, 300)),
        assistantResponses: assistantMessages.slice(0, 3).map(m => m.substring(0, 200)),
        filesModified: files,
        toolsUsed: tools
      };
    });

    const prompt = `Analyze these development sessions and identify TASK/SOLUTION pairs.

A "task" is ANY development work request - not just bugs/errors. This includes:
- Feature implementations ("add a button", "implement caching")
- Refactoring ("refactor this code", "clean up")
- Configuration changes ("update the config", "change settings")
- Documentation ("update docs", "add comments")
- Investigation/research ("figure out why", "understand how")
- Bug fixes ("fix the error", "resolve the issue")

For each task/solution pair found, extract:
- The task/problem/request (what the user wanted to accomplish)
- The solution approach taken
- Key steps or actions performed
- Technologies/tools involved
- Outcome (success, partial, blocked)
- Difficulty (low, medium, high)

Sessions (batch ${batchIndex + 1}):
${JSON.stringify(sessionSummaries, null, 2)}

Return a JSON array of task/solution pairs:
[{
  "task": "Brief description of what was requested/needed",
  "context": "Additional context about the task",
  "difficulty": "low|medium|high",
  "approach": "How the solution was approached",
  "steps": ["step1", "step2"],
  "technologies": ["tech1", "tech2"],
  "outcome": "success|partial|blocked",
  "sessionFilename": "the session filename where this occurred"
}]

Focus on SUBSTANTIVE development tasks. Skip trivial commands (sl, help queries).
Return 2-6 pairs per batch. Return ONLY the JSON array, no other text.`;

    try {
      const result = await this.semanticAnalyzer.analyzeContent(prompt, {
        analysisType: "patterns",
        provider: "auto"
      });

      // Parse LLM response
      const jsonMatch = result.insights.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        log(`No JSON array found in problem/solution LLM response for batch ${batchIndex}`, 'warning');
        return [];
      }

      const rawPairs = JSON.parse(jsonMatch[0]) as Array<{
        task: string;
        context?: string;
        difficulty: string;
        approach: string;
        steps: string[];
        technologies: string[];
        outcome: string;
        sessionFilename?: string;
      }>;

      // Transform to ProblemSolutionPair format
      return rawPairs.map(p => ({
        problem: {
          description: p.task,
          context: p.context || p.task,
          difficulty: (p.difficulty as 'low' | 'medium' | 'high') || 'medium'
        },
        solution: {
          approach: p.approach,
          steps: p.steps || [],
          technologies: p.technologies || [],
          outcome: (p.outcome as 'success' | 'partial' | 'blocked') || 'success'
        },
        metadata: {
          session: p.sessionFilename || sessions[0]?.filename || 'unknown',
          timestamp: sessions[0]?.timestamp || new Date(),
          exchanges: []
        }
      }));

    } catch (error) {
      log(`LLM problem/solution extraction failed for batch ${batchIndex}`, 'warning', error);
      return [];
    }
  }

  // DEPRECATED: Legacy keyword-based detection - kept only for reference
  // This method is no longer used. Use identifyProblemSolutionPairs() which uses LLM.
  private _legacyIsProblemDescription(message: string): boolean {
    const problemIndicators = [
      'error', 'problem', 'issue', 'bug', 'fail', 'broken',
      'not working', 'help with', 'struggling with', 'stuck on'
    ];

    const lowerMessage = message.toLowerCase();
    return problemIndicators.some(indicator => lowerMessage.includes(indicator)) &&
           message.length > 50;
  }

  private buildProblemDescription(exchange: ConversationExchange): ProblemSolutionPair['problem'] {
    const description = exchange.userMessage.split('\n')[0].trim();
    const context = exchange.userMessage;
    
    // Assess difficulty based on message length and complexity
    let difficulty: 'low' | 'medium' | 'high' = 'medium';
    if (context.length < 100) difficulty = 'low';
    else if (context.length > 500) difficulty = 'high';

    return {
      description,
      context,
      difficulty
    };
  }

  private extractSolution(exchanges: ConversationExchange[]): ProblemSolutionPair['solution'] | null {
    if (exchanges.length === 0) return null;

    // In LSL format, user messages and tool responses are often in separate prompt sets
    // So we need to look for solutions in multiple ways:

    // 1. Find exchange with substantial assistant message (original approach)
    let solutionExchange = exchanges.find(e => e.assistantMessage.length > 200);

    // 2. If no substantial message, look for exchanges with tool usage (indicates work done)
    if (!solutionExchange) {
      solutionExchange = exchanges.find(e =>
        (e.context?.tools && e.context.tools.length > 2) ||
        (e.context?.files && e.context.files.length > 0)
      );
    }

    // 3. If still nothing, check if any exchange shows edit/write activity
    if (!solutionExchange) {
      solutionExchange = exchanges.find(e => {
        const tools = e.context?.tools || [];
        return tools.some(t =>
          t.toLowerCase().includes('edit') ||
          t.toLowerCase().includes('write') ||
          t.toLowerCase().includes('bash')
        );
      });
    }

    if (!solutionExchange) return null;

    const approach = this.extractSolutionApproach([solutionExchange]);
    const steps = this.extractSolutionSteps(solutionExchange.assistantMessage);
    const technologies = this.extractTechnologies(solutionExchange);
    const outcome = this.extractSolutionOutcome(exchanges);

    return {
      approach,
      steps,
      technologies,
      outcome
    };
  }

  private extractSolutionSteps(message: string): string[] {
    const steps: string[] = [];
    
    // Look for numbered lists
    const numberedSteps = message.match(/^\d+\.\s+(.+)$/gm);
    if (numberedSteps) {
      return numberedSteps.map(step => step.replace(/^\d+\.\s+/, '').trim());
    }

    // Look for bulleted lists
    const bulletedSteps = message.match(/^[-*]\s+(.+)$/gm);
    if (bulletedSteps) {
      return bulletedSteps.map(step => step.replace(/^[-*]\s+/, '').trim());
    }

    // Extract sentences that look like steps
    const sentences = message.split(/[.!?]+/);
    sentences.forEach(sentence => {
      if (sentence.includes('will') || sentence.includes('need to') || sentence.includes('should')) {
        steps.push(sentence.trim());
      }
    });

    return steps.slice(0, 5);
  }

  private extractTechnologies(exchange: ConversationExchange): string[] {
    const technologies: string[] = [];
    
    // From tools used
    exchange.context.tools.forEach(tool => technologies.push(tool));
    
    // From files (extract file extensions)
    exchange.context.files.forEach(file => {
      const ext = path.extname(file).toLowerCase();
      const techMap: Record<string, string> = {
        '.ts': 'TypeScript',
        '.js': 'JavaScript',
        '.json': 'JSON',
        '.md': 'Markdown',
        '.py': 'Python',
        '.yml': 'YAML',
        '.yaml': 'YAML'
      };
      
      if (techMap[ext] && !technologies.includes(techMap[ext])) {
        technologies.push(techMap[ext]);
      }
    });

    return technologies;
  }

  private extractSolutionOutcome(exchanges: ConversationExchange[]): string {
    const lastExchange = exchanges[exchanges.length - 1];
    
    // Look for completion indicators
    const completionPatterns = [
      'successfully completed',
      'working correctly',
      'issue resolved',
      'implemented successfully',
      'fixed the problem'
    ];

    for (const pattern of completionPatterns) {
      if (lastExchange?.assistantMessage.toLowerCase().includes(pattern)) {
        return pattern;
      }
    }

    return 'Solution implemented';
  }

  private analyzePatterns(
    sessions: ConversationSession[],
    contexts: DevelopmentContext[],
    pairs: ProblemSolutionPair[]
  ): VibeHistoryAnalysisResult['patterns'] {
    // Common problems
    const problemCounts = new Map<string, number>();
    pairs.forEach(pair => {
      const problem = pair.problem.description.substring(0, 100) + '...';
      problemCounts.set(problem, (problemCounts.get(problem) || 0) + 1);
    });

    const commonProblems = Array.from(problemCounts.entries())
      .map(([problem, frequency]) => ({ problem, frequency }))
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 5);

    // Preferred solutions
    const solutionCounts = new Map<string, number>();
    pairs.forEach(pair => {
      const approach = pair.solution.approach;
      solutionCounts.set(approach, (solutionCounts.get(approach) || 0) + 1);
    });

    const preferredSolutions = Array.from(solutionCounts.entries())
      .map(([solution, frequency]) => ({ solution, frequency }))
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 5);

    // Tool usage
    const toolCounts = new Map<string, number>();
    sessions.forEach(session => {
      session.exchanges.forEach(exchange => {
        exchange.context.tools.forEach(tool => {
          toolCounts.set(tool, (toolCounts.get(tool) || 0) + 1);
        });
      });
    });

    const toolUsage = Array.from(toolCounts.entries())
      .map(([tool, frequency]) => ({ tool, frequency }))
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 5);

    // Development themes
    const themeCounts = new Map<string, number>();
    contexts.forEach(context => {
      themeCounts.set(context.problemType, (themeCounts.get(context.problemType) || 0) + 1);
    });

    const developmentThemes = Array.from(themeCounts.entries())
      .map(([theme, frequency]) => ({ theme, frequency }))
      .sort((a, b) => b.frequency - a.frequency);

    return {
      commonProblems,
      preferredSolutions,
      toolUsage,
      developmentThemes
    };
  }

  private async generateSummary(
    sessions: ConversationSession[],
    contexts: DevelopmentContext[],
    pairs: ProblemSolutionPair[],
    patterns: VibeHistoryAnalysisResult['patterns'],
    skipLlmEnhancement = false,
    keyTopics: KeyTopic[] = []
  ): Promise<VibeHistoryAnalysisResult['summary']> {
    const totalExchanges = sessions.reduce((sum, s) => sum + s.exchanges.length, 0);

    // Use key topics for primary focus if available
    const primaryFocus = keyTopics.length > 0
      ? keyTopics[0].topic
      : patterns.developmentThemes.length > 0
        ? patterns.developmentThemes[0].theme
        : 'General Development';

    const keyLearnings: string[] = [];

    // Extract key learnings from key topics (preferred over problem-solution pairs)
    keyTopics.slice(0, 5).forEach(topic => {
      const decisionSummary = topic.keyDecisions.length > 0 ? `: ${topic.keyDecisions[0]}` : '';
      keyLearnings.push(`[${topic.category}] ${topic.topic}${decisionSummary}`);
    });

    // Fall back to problem-solution pairs if no key topics
    if (keyLearnings.length === 0) {
      pairs.slice(0, 3).forEach(pair => {
        if (pair.solution.outcome !== 'Solution implemented') {
          keyLearnings.push(`${pair.problem.description.substring(0, 80)}... → ${pair.solution.outcome}`);
        }
      });
    }

    // Add pattern insights
    if (patterns.preferredSolutions.length > 0) {
      keyLearnings.push(`Preferred approach: ${patterns.preferredSolutions[0].solution}`);
    }

    // Top topics for summary (sorted by significance)
    const topTopics = keyTopics
      .sort((a, b) => b.significance - a.significance)
      .slice(0, 5)
      .map(t => t.topic);

    // Base insights (always generated - no LLM needed)
    let enhancedInsights = keyTopics.length > 0
      ? `Analyzed ${sessions.length} conversation sessions. Extracted ${keyTopics.length} key development topics. ` +
        `Top focus areas: ${topTopics.slice(0, 3).join(', ')}. ` +
        `Technologies involved: ${[...new Set(keyTopics.flatMap(t => t.technologies))].slice(0, 5).join(', ') || 'various'}.`
      : `Analyzed ${sessions.length} conversation sessions with ${totalExchanges} exchanges. ` +
        `Primary development focus: ${primaryFocus}. ` +
        `Most used tool: ${patterns.toolUsage[0]?.tool || 'N/A'}.`;

    // Skip LLM enhancement if requested (for performance)
    if (skipLlmEnhancement) {
      log('Skipping LLM enhancement for faster processing', 'info');
      return {
        totalExchanges,
        primaryFocus,
        keyLearnings: keyLearnings.slice(0, 5),
        insights: enhancedInsights,
        topTopics
      };
    }

    try {
      // Build context for LLM analysis
      const analysisContext = {
        sessionCount: sessions.length,
        totalExchanges,
        primaryTheme: primaryFocus,
        topProblems: patterns.commonProblems.slice(0, 3).map(p => p.problem),
        topSolutions: patterns.preferredSolutions.slice(0, 3).map(s => s.solution),
        mostUsedTools: patterns.toolUsage.slice(0, 5).map(t => t.tool),
        themes: patterns.developmentThemes.slice(0, 3).map(t => t.theme)
      };

      const prompt = `Analyze these development session patterns and provide actionable insights:

Context:
- ${analysisContext.sessionCount} sessions with ${analysisContext.totalExchanges} exchanges
- Primary focus: ${analysisContext.primaryTheme}
- Common problems: ${analysisContext.topProblems.join(', ')}
- Preferred solutions: ${analysisContext.topSolutions.join(', ')}
- Most used tools: ${analysisContext.mostUsedTools.join(', ')}
- Development themes: ${analysisContext.themes.join(', ')}

Provide a JSON response:
{
  "executiveSummary": string, // 2-3 sentence high-level summary
  "keyPatterns": string[], // 3-4 important patterns discovered
  "recommendations": string[], // 2-3 actionable recommendations
  "trendAnalysis": string // Overall trend or direction
}`;

      const result = await this.semanticAnalyzer.analyzeContent(prompt, {
        analysisType: "patterns",
        provider: "auto"
      });

      const llmInsights = JSON.parse(result.insights);

      // Enhance key learnings with LLM-discovered patterns
      if (llmInsights.keyPatterns) {
        llmInsights.keyPatterns.forEach((pattern: string) => {
          if (!keyLearnings.includes(pattern)) {
            keyLearnings.push(pattern);
          }
        });
      }

      // Use LLM-generated summary if available
      if (llmInsights.executiveSummary) {
        enhancedInsights = llmInsights.executiveSummary;
      }

      log("LLM-enhanced session summary generated", "info", {
        patternsFound: llmInsights.keyPatterns?.length || 0,
        recommendations: llmInsights.recommendations?.length || 0
      });

    } catch (error) {
      log("LLM summary enhancement failed, using template-based summary", "warning", error);
      // Fall back to template-based insights (already set above)
    }

    return {
      totalExchanges,
      primaryFocus,
      keyLearnings: keyLearnings.slice(0, 5), // Limit to top 5
      insights: enhancedInsights,
      topTopics
    };
  }
}