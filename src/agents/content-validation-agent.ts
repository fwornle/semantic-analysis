/**
 * ContentValidationAgent
 *
 * Validates that entity content (observations, insights, PlantUML diagrams) is accurate
 * and in-sync with the current codebase before updates.
 *
 * Key responsibilities:
 * 1. Parse entities for file paths, command names, API endpoints
 * 2. Verify references exist in codebase
 * 3. Detect stale observations and diagrams
 * 4. Generate refresh reports with actionable recommendations
 */

import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
// Phase 42.2 Plan 04 — legacy persistence trio retired.
// GraphDatabaseAdapter + PersistenceAgent type imports replaced with the
// km-core adapter surface (Phase 42-01 strangler) plus the file-system
// helpers from legacy-consumer-helpers.ts.
import type { KmCoreAdapter } from "../storage/km-core-adapter.js";
import { cleanupEntityFiles as cleanupEntityFilesViaAdapter } from "../storage/legacy-consumer-helpers.js";
import { SemanticAnalyzer } from "./semantic-analyzer.js";
import type { InsightGenerationAgent } from "./insight-generation-agent.js";
import { GitHistoryAgent } from "./git-history-agent.js";
import { VibeHistoryAgent } from "./vibe-history-agent.js";
import { GitStalenessDetector, CommitEntityCorrelation } from "./git-staleness-detector.js";
import { log as centralLog } from "../logging.js";

// Simple logger wrapper for content validation
const log = (message: string, level: string = "info", data?: any) => {
  centralLog(`[ContentValidationAgent] ${message}`, level as any, data);
};

// Validation result interfaces
export interface ValidationIssue {
  type: "error" | "warning" | "info";
  category: "file_reference" | "command_reference" | "api_endpoint" | "component_reference" | "diagram_staleness" | "observation_staleness";
  message: string;
  reference: string;
  suggestion?: string;
  location?: string;
}

export interface ObservationValidation {
  observation: string;
  isValid: boolean;
  issues: ValidationIssue[];
  extractedReferences: {
    files: string[];
    commands: string[];
    components: string[];
    apis: string[];
  };
}

export interface DiagramValidation {
  diagramPath: string;
  isValid: boolean;
  issues: ValidationIssue[];
  referencedComponents: string[];
  missingComponents: string[];
}

export interface InsightValidation {
  insightPath: string;
  isValid: boolean;
  issues: ValidationIssue[];
  outdatedSections: string[];
  diagramValidations: DiagramValidation[];
}

export interface EntityValidationReport {
  entityName: string;
  team: string;
  validatedAt: string;
  overallValid: boolean;
  overallScore: number; // 0-100
  totalIssues: number;
  criticalIssues: number;
  observationValidations: ObservationValidation[];
  insightValidation?: InsightValidation;
  recommendations: string[];
  suggestedActions: {
    removeObservations: string[];
    updateObservations: string[];
    regenerateDiagrams: string[];
    refreshInsight: boolean;
  };
  // Git-based staleness detection results
  gitStaleness?: {
    isStale: boolean;
    invalidatingCommits: string[];
    correlations: CommitEntityCorrelation[];
    stalenessScore: number;
  };
}

export interface StaleEntityInfo {
  entityName: string;
  entityType: string;
  staleness: 'critical' | 'moderate' | 'low';
  score: number;
  issues: ValidationIssue[];
  requiresRefresh: boolean;
  lastUpdated?: string;
}

export interface StaleEntitiesValidationResult {
  validatedAt: string;
  totalEntitiesChecked: number;
  staleEntitiesFound: number;
  criticalStaleEntities: number;
  staleEntities: StaleEntityInfo[];
  refreshActions: {
    entityName: string;
    action: 'deleted' | 'delete_failed' | 'scheduled_for_refresh' | 'auto_refreshed' | 'manual_review_required';
    reason: string;
  }[];
  summary: string;
}

export interface ContentValidationAgentConfig {
  repositoryPath: string;
  insightsDirectory: string;
  enableDeepValidation: boolean;
  stalenessThresholdDays?: number;
  useGitBasedDetection?: boolean; // Use git commit history for staleness detection (default: true)
  parallelWorkers?: number; // Number of parallel workers for batch refresh (default: 1, max: 20)
  team?: string; // Team name for knowledge base operations (default: derived from repositoryPath)
}

// Entity refresh result interfaces
export interface ObservationRefreshResult {
  removed: string[];
  added: string[];
  unchanged: number;
}

export interface EntityRefreshResult {
  entityName: string;
  team: string;
  refreshedAt: string;
  validationBefore: EntityValidationReport;
  validationAfter?: EntityValidationReport;
  observationChanges: ObservationRefreshResult;
  diagramsRegenerated: string[];
  insightRefreshed: boolean;
  success: boolean;
  error?: string;
  // Entity rename tracking
  renamedFrom?: string;
  renamedTo?: string;
  cleanedUpFiles?: string[];
}

export class ContentValidationAgent {
  private repositoryPath: string;
  private insightsDirectory: string;
  private enableDeepValidation: boolean;
  private stalenessThresholdDays: number;
  // Phase 42.2 Plan 04 — both legacy slots collapsed into a single
  // km-core adapter handle. The pre-existing graphDB / persistenceAgent
  // field names are preserved (typed as KmCoreAdapter) to minimize the
  // call-site diff downstream — graphDB.queryEntities, graphDB.initialized,
  // persistenceAgent.renameEntity, persistenceAgent.updateEntityObservations
  // all exist on the adapter surface as of this plan.
  private graphDB: KmCoreAdapter | null = null;
  private semanticAnalyzer: SemanticAnalyzer;
  private persistenceAgent: KmCoreAdapter | null = null;
  private insightGenerationAgent: InsightGenerationAgent | null = null;
  private gitHistoryAgent: GitHistoryAgent | null = null;
  private vibeHistoryAgent: VibeHistoryAgent | null = null;
  private gitStalenessDetector: GitStalenessDetector | null = null;
  private useGitBasedDetection: boolean;
  private parallelWorkers: number;
  private team: string;

  // Cached git commits for batch validation (prevents re-fetching per entity)
  private cachedGitCommits: any[] | null = null;
  private cachedGitCommitsTimestamp: number = 0;
  private static readonly GIT_CACHE_TTL_MS = 60000; // 1 minute cache TTL

  // Known patterns for reference extraction
  private filePathPatterns = [
    /`([^`]+\.[a-z]{2,4})`/gi,                          // `file.ts`
    /\b(src\/[^\s,)]+)/gi,                              // src/path/file.ts
    /\b(integrations\/[^\s,)]+)/gi,                     // integrations/path/file.ts
    /\b(lib\/[^\s,)]+)/gi,                              // lib/path/file.ts
    /\b(scripts\/[^\s,)]+)/gi,                          // scripts/path/file.ts
    /\b(config\/[^\s,)]+)/gi,                           // config/path/file.ts
  ];

  private commandPatterns = [
    /\b(ukb|vkb|coding|claude-mcp)\b/gi,                // Known commands
    /`([a-z][a-z0-9-]+)`\s+command/gi,                  // `command` command
    /run\s+`([^`]+)`/gi,                                // run `command`
    /execute\s+`([^`]+)`/gi,                            // execute `command`
  ];

  private componentPatterns = [
    /\b([A-Z][a-zA-Z0-9]+Agent)\b/g,                    // *Agent classes
    /\b([A-Z][a-zA-Z0-9]+Service)\b/g,                  // *Service classes
    /\b([A-Z][a-zA-Z0-9]+Manager)\b/g,                  // *Manager classes
    /\b([A-Z][a-zA-Z0-9]+Adapter)\b/g,                  // *Adapter classes
  ];

  constructor(config?: Partial<ContentValidationAgentConfig>) {
    this.repositoryPath = config?.repositoryPath || process.cwd();
    this.insightsDirectory = config?.insightsDirectory ||
      path.join(this.repositoryPath, "knowledge-management", "insights");
    this.enableDeepValidation = config?.enableDeepValidation ?? true;
    this.stalenessThresholdDays = config?.stalenessThresholdDays ?? 30;
    this.useGitBasedDetection = config?.useGitBasedDetection ?? true;
    // Parallel workers: default 10 for efficient batch processing, max 20
    // Increased from 1 to 10 to better utilize parallelization for validation
    this.parallelWorkers = Math.min(Math.max(config?.parallelWorkers ?? 10, 1), 20);
    // Team: derive from repository path basename if not provided
    this.team = config?.team || path.basename(this.repositoryPath);
    this.semanticAnalyzer = new SemanticAnalyzer();

    // Initialize GitStalenessDetector for git-based staleness detection
    if (this.useGitBasedDetection) {
      this.gitStalenessDetector = new GitStalenessDetector();
    }

    log(`ContentValidationAgent initialized`, "info", {
      repositoryPath: this.repositoryPath,
      insightsDirectory: this.insightsDirectory,
      enableDeepValidation: this.enableDeepValidation,
      useGitBasedDetection: this.useGitBasedDetection,
      parallelWorkers: this.parallelWorkers
    });
  }

  /**
   * Phase 42.2 Plan 04 — single setter that collapses the legacy
   * setGraphDB + setPersistenceAgent pair. The km-core adapter exposes
   * both the read surface (queryEntities, getEntity) and the mutation
   * surface (renameEntity, updateEntityObservations) needed downstream,
   * so one handle suffices.
   */
  setKmCoreAdapter(adapter: KmCoreAdapter): void {
    this.graphDB = adapter;
    this.persistenceAgent = adapter;
    log('km-core adapter set for ContentValidationAgent (collapsed graphDB + persistenceAgent slots)', 'info');
  }

  /**
   * Set the InsightGenerationAgent for regenerating insights during entity refresh
   */
  setInsightGenerationAgent(insightGenerationAgent: InsightGenerationAgent): void {
    this.insightGenerationAgent = insightGenerationAgent;
    log('InsightGenerationAgent set for ContentValidationAgent', 'info');
  }

  /**
   * Initialize analysis agents for entity refresh operations
   * Creates GitHistoryAgent and VibeHistoryAgent for running fresh analysis
   */
  initializeAnalysisAgents(): void {
    if (!this.gitHistoryAgent) {
      this.gitHistoryAgent = new GitHistoryAgent(this.repositoryPath);
    }
    if (!this.vibeHistoryAgent) {
      this.vibeHistoryAgent = new VibeHistoryAgent(this.repositoryPath);
    }
    log('Analysis agents initialized for entity refresh', 'info');
  }

  /**
   * Detect entity staleness using git commit history
   * Uses three-tier matching: file-path, topic/embedding, and LLM correlation
   * @param entity - The entity to check for staleness
   * @param team - The team/project namespace
   * @returns Array of commit-entity correlations indicating staleness
   */
  async detectEntityGitStaleness(
    entity: { name: string; entityType?: string; observations?: any[]; metadata?: any },
    team: string,
    prefetchedCommits?: any[] // Optional pre-fetched commits to avoid per-entity git calls
  ): Promise<{
    isStale: boolean;
    correlations: CommitEntityCorrelation[];
    stalenessScore: number; // 0-100, 100 = fresh
    invalidatingCommits: string[];
  }> {
    // Default result - entity is fresh
    const result = {
      isStale: false,
      correlations: [] as CommitEntityCorrelation[],
      stalenessScore: 100,
      invalidatingCommits: [] as string[],
    };

    if (!this.useGitBasedDetection || !this.gitStalenessDetector) {
      log(`Git-based detection disabled, skipping`, 'debug', { entityName: entity.name });
      return result;
    }

    // Initialize git history agent if not already done
    if (!this.gitHistoryAgent) {
      this.gitHistoryAgent = new GitHistoryAgent(this.repositoryPath);
    }

    try {
      let commits: any[];

      // Use pre-fetched commits if provided (batch optimization)
      if (prefetchedCommits && prefetchedCommits.length > 0) {
        commits = prefetchedCommits;
        log(`Using ${commits.length} pre-fetched commits for entity`, 'debug', { entityName: entity.name });
      } else {
        // Fallback: fetch commits for this specific entity
        // Get entity's last modification timestamp
        const lastModTime = entity.metadata?.last_updated
          ? new Date(entity.metadata.last_updated)
          : null;

        if (!lastModTime) {
          log(`Entity has no last_updated timestamp, treating as potentially stale`, 'debug', {
            entityName: entity.name
          });
        }

        // Get commits since entity was last modified (or last 30 days if no timestamp)
        const sinceDate = lastModTime || new Date(Date.now() - this.stalenessThresholdDays * 24 * 60 * 60 * 1000);

        // Use analyzeGitHistory to get commits - returns full analysis including commits array
        const analysisResult = await this.gitHistoryAgent.analyzeGitHistory({
          fromTimestamp: sinceDate.toISOString(),
          checkpoint_enabled: false // Don't use checkpoints for staleness detection
        });
        commits = analysisResult.commits;
      }

      if (commits.length === 0) {
        log(`No commits found for staleness check`, 'debug', {
          entityName: entity.name
        });
        return result;
      }

      log(`Checking ${commits.length} commits against entity`, 'debug', {
        entityName: entity.name
      });

      // Convert entity format for GitStalenessDetector
      const graphEntity = {
        name: entity.name,
        entityType: entity.entityType,
        observations: entity.observations,
        metadata: entity.metadata
      };

      // Detect staleness using three-tier matching
      const correlations = await this.gitStalenessDetector.detectStaleness(commits, [graphEntity]);

      // Filter for correlations related to this entity that indicate staleness
      const relevantCorrelations = correlations.filter(
        c => c.entityName === entity.name && c.isStale
      );

      if (relevantCorrelations.length > 0) {
        result.isStale = true;
        result.correlations = relevantCorrelations;
        result.invalidatingCommits = relevantCorrelations.map(c => c.commitHash);

        // Calculate staleness score based on correlation relevance scores
        // Higher relevance = lower freshness score
        const avgRelevance = relevantCorrelations.reduce((sum, c) => sum + c.relevanceScore, 0) / relevantCorrelations.length;
        result.stalenessScore = Math.round((1 - avgRelevance) * 100);

        log(`Entity detected as stale via git analysis`, 'info', {
          entityName: entity.name,
          invalidatingCommits: result.invalidatingCommits.length,
          stalenessScore: result.stalenessScore,
          topMethod: relevantCorrelations[0]?.matchMethod
        });
      }

      return result;
    } catch (error) {
      log(`Error during git-based staleness detection`, 'error', { entityName: entity.name, error });
      // On error, return fresh status to avoid false positives
      return result;
    }
  }

  /**
   * Validate all entities in the graph database for staleness
   * Called during incremental-analysis workflow to detect outdated entities
   */
  async validateAndRefreshStaleEntities(params: {
    semantic_analysis_results?: any;
    observations?: any;
    stalenessThresholdDays?: number;
    autoRefresh?: boolean;
  }): Promise<StaleEntitiesValidationResult> {
    log('Starting stale entity validation (git-based detection)', 'info', params);

    const result: StaleEntitiesValidationResult = {
      validatedAt: new Date().toISOString(),
      totalEntitiesChecked: 0,
      staleEntitiesFound: 0,
      criticalStaleEntities: 0,
      staleEntities: [],
      refreshActions: [],
      summary: ''
    };

    try {
      // Phase 42.2 Plan 04 — adapter must be set via setKmCoreAdapter() before
      // calling this method. Lazy-init is no longer possible because the
      // km-core GraphKMStore needs an ontologyDir / dbPath that this class
      // cannot synthesize standalone (the legacy GraphDatabaseAdapter had no
      // such requirement). Coordinator + tools handlers wire the adapter
      // upstream before calling here.
      if (!this.graphDB) {
        const errorMsg = 'km-core adapter not set on ContentValidationAgent. Call setKmCoreAdapter() before validation methods.';
        log(errorMsg, 'error');
        throw new Error(errorMsg);
      }

      const allEntities = await this.graphDB.queryEntities({}) || [];

      // Limit processing to prevent extremely long runs
      const MAX_ENTITIES_TO_CHECK = 100;
      const entities = allEntities.slice(0, MAX_ENTITIES_TO_CHECK);
      result.totalEntitiesChecked = entities.length;

      if (allEntities.length > MAX_ENTITIES_TO_CHECK) {
        log(`Large knowledge base: ${allEntities.length} entities, checking first ${MAX_ENTITIES_TO_CHECK}`, 'warning');
      } else {
        log(`Checking ${entities.length} entities for staleness via git-based detection`, 'info');
      }

      const team = this.team;

      // OPTIMIZATION: Pre-fetch git commits ONCE for all entities (major performance improvement)
      let prefetchedCommits: any[] = [];
      if (this.useGitBasedDetection) {
        // Initialize git history agent if not already done
        if (!this.gitHistoryAgent) {
          this.gitHistoryAgent = new GitHistoryAgent(this.repositoryPath);
        }

        const sinceDate = new Date(Date.now() - this.stalenessThresholdDays * 24 * 60 * 60 * 1000);
        log(`Pre-fetching git commits since ${sinceDate.toISOString()} for batch validation`, 'info');

        try {
          const analysisResult = await this.gitHistoryAgent.analyzeGitHistory({
            fromTimestamp: sinceDate.toISOString(),
            checkpoint_enabled: false
          });
          prefetchedCommits = analysisResult.commits || [];
          log(`Pre-fetched ${prefetchedCommits.length} commits for batch staleness detection`, 'info');
        } catch (error) {
          log(`Failed to pre-fetch git commits, will fetch per-entity`, 'warning', error);
        }
      }

      // OPTIMIZATION: Process entities in parallel batches (instead of sequential)
      const PARALLEL_BATCH_SIZE = 10; // Process 10 entities concurrently
      const validationResults: Array<{
        entity: any;
        entityName: string;
        entityType: string;
        issues: ValidationIssue[];
        staleness: 'critical' | 'moderate' | 'low';
        score: number;
      }> = [];

      // Helper function to validate a single entity
      const validateEntity = async (entity: any) => {
        const entityName = entity.name || entity.id || 'Unknown';
        const entityType = entity.type || entity.entityType || 'Unknown';
        const observations = entity.observations || [];

        const issues: ValidationIssue[] = [];
        let staleness: 'critical' | 'moderate' | 'low' = 'low';
        let score = 100;

        // Use git-based staleness detection with pre-fetched commits
        if (this.useGitBasedDetection) {
          const gitStaleness = await this.detectEntityGitStaleness(entity, team, prefetchedCommits);

          if (gitStaleness.isStale) {
            if (gitStaleness.stalenessScore < 40) {
              staleness = 'critical';
            } else if (gitStaleness.stalenessScore < 70) {
              staleness = 'moderate';
            }
            score = gitStaleness.stalenessScore;

            for (const correlation of gitStaleness.correlations) {
              issues.push({
                type: staleness === 'critical' ? 'error' : 'warning',
                category: 'observation_staleness',
                message: `Entity may be outdated: commit ${correlation.commitHash.substring(0, 8)} (${correlation.matchMethod})`,
                reference: correlation.commitMessage.substring(0, 100),
                suggestion: `Review entity against recent changes: ${correlation.matchDetails?.substring(0, 80) || 'N/A'}`
              });
            }
          }
        }

        // Validate file references in observations (synchronous file existence checks)
        for (const observation of observations) {
          const obsText = typeof observation === 'string' ? observation : observation.content || '';
          const fileRefs = this.extractFileReferences(obsText);
          for (const fileRef of fileRefs) {
            if (!this.fileExists(fileRef)) {
              issues.push({
                type: 'warning',
                category: 'file_reference',
                message: `Referenced file no longer exists: ${fileRef}`,
                reference: fileRef,
                suggestion: 'Update or remove this file reference'
              });
              score -= 10;
              if (staleness === 'low') staleness = 'moderate';
            }
          }
        }

        return { entity, entityName, entityType, issues, staleness, score };
      };

      // Process entities in parallel batches
      for (let i = 0; i < entities.length; i += PARALLEL_BATCH_SIZE) {
        const batch = entities.slice(i, i + PARALLEL_BATCH_SIZE);
        const batchNum = Math.floor(i / PARALLEL_BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(entities.length / PARALLEL_BATCH_SIZE);

        log(`Processing validation batch ${batchNum}/${totalBatches} (${batch.length} entities in parallel)`, 'debug');

        const batchResults = await Promise.all(batch.map(validateEntity));
        validationResults.push(...batchResults);
      }

      // Aggregate results from parallel validation
      for (const { entity, entityName, entityType, issues, staleness, score } of validationResults) {
        if (issues.length > 0) {
          result.staleEntitiesFound++;
          if (staleness === 'critical') {
            result.criticalStaleEntities++;
          }

          const staleEntity: StaleEntityInfo = {
            entityName,
            entityType,
            staleness,
            score: Math.max(0, score),
            issues,
            requiresRefresh: staleness === 'critical' || score < 50,
            lastUpdated: entity.updatedAt || entity.createdAt
          };

          result.staleEntities.push(staleEntity);

          // Determine action - NOTE: We now mark for review rather than auto-delete
          // Git-based detection may have false positives, so manual review is preferred
          if (staleness === 'critical') {
            result.refreshActions.push({
              entityName,
              action: 'manual_review_required',
              reason: `Git-based staleness detected: ${issues.length} relevant commits found. Review before making changes.`
            });
          }
        }
      }

      // Generate summary
      result.summary = this.generateStalenessSummary(result);

      log('Stale entity validation complete (git-based)', 'info', {
        totalChecked: result.totalEntitiesChecked,
        staleFound: result.staleEntitiesFound,
        critical: result.criticalStaleEntities,
        method: 'git-based-detection'
      });

    } catch (error) {
      log('Error during stale entity validation', 'error', error);
      result.summary = `Validation error: ${error instanceof Error ? error.message : String(error)}`;
    }

    return result;
  }

  /**
   * Generate a human-readable summary of staleness validation
   */
  private generateStalenessSummary(result: StaleEntitiesValidationResult): string {
    const lines: string[] = [];

    lines.push(`## Stale Entity Validation Summary`);
    lines.push(`Validated at: ${result.validatedAt}`);
    lines.push(`Total entities checked: ${result.totalEntitiesChecked}`);
    lines.push(`Stale entities found: ${result.staleEntitiesFound}`);
    lines.push(`Critical stale entities: ${result.criticalStaleEntities}`);
    lines.push('');

    if (result.staleEntities.length > 0) {
      lines.push(`### Stale Entities Requiring Attention`);
      for (const entity of result.staleEntities) {
        lines.push(`- **${entity.entityName}** (${entity.entityType})`);
        lines.push(`  - Staleness: ${entity.staleness.toUpperCase()}, Score: ${entity.score}/100`);
        lines.push(`  - Issues: ${entity.issues.length}`);
        for (const issue of entity.issues.slice(0, 3)) {
          lines.push(`    - [${issue.type}] ${issue.message}`);
        }
        if (entity.issues.length > 3) {
          lines.push(`    - ... and ${entity.issues.length - 3} more issues`);
        }
      }
    } else {
      lines.push('All entities are up-to-date. No staleness detected.');
    }

    if (result.refreshActions.length > 0) {
      lines.push('');
      lines.push(`### Recommended Actions`);
      for (const action of result.refreshActions) {
        lines.push(`- ${action.entityName}: ${action.action} - ${action.reason}`);
      }
    }

    return lines.join('\n');
  }

  // ==================== Batch Validation Methods ====================

  /**
   * Validate all entities for a specific project/team
   * Returns validation reports for each entity with aggregated summary
   */
  async validateEntitiesByProject(team: string, options?: {
    maxEntities?: number;
    skipHealthyEntities?: boolean;
    progressCallback?: (current: number, total: number, entityName: string) => void;
  }): Promise<{
    team: string;
    validatedAt: string;
    totalEntities: number;
    validatedEntities: number;
    invalidEntities: number;
    reports: EntityValidationReport[];
    summary: string;
  }> {
    const startTime = Date.now();
    const maxEntities = options?.maxEntities ?? Infinity;
    const skipHealthy = options?.skipHealthyEntities ?? false;

    log(`Starting batch validation for project: ${team}`, "info");

    const result = {
      team,
      validatedAt: new Date().toISOString(),
      totalEntities: 0,
      validatedEntities: 0,
      invalidEntities: 0,
      reports: [] as EntityValidationReport[],
      summary: ""
    };

    try {
      // Get all entities for this team
      let entities: any[] = [];

      if (this.graphDB && this.graphDB.initialized) {
        entities = await this.graphDB.queryEntities({});
      } else {
        // Fallback to knowledge export file
        const knowledgeExportPath = path.join(
          this.repositoryPath,
          '.data',
          'knowledge-export',
          `${team}.json`
        );
        try {
          const content = JSON.parse(await fsPromises.readFile(knowledgeExportPath, "utf-8"));
          entities = content.entities || [];
        } catch {
          log(`No knowledge export found for team: ${team}`, "warning");
        }
      }

      result.totalEntities = entities.length;
      const entitiesToValidate = entities.slice(0, maxEntities);

      // OPTIMIZATION: Pre-fetch git commits ONCE for all entities (major performance improvement)
      // This avoids running analyzeGitHistory() for each entity, which was the main bottleneck
      let prefetchedCommits: any[] = [];
      if (this.useGitBasedDetection && entitiesToValidate.length > 0) {
        // Initialize git history agent if not already done
        if (!this.gitHistoryAgent) {
          this.gitHistoryAgent = new GitHistoryAgent(this.repositoryPath);
        }

        const sinceDate = new Date(Date.now() - this.stalenessThresholdDays * 24 * 60 * 60 * 1000);
        log(`Pre-fetching git commits since ${sinceDate.toISOString()} for batch validation of ${entitiesToValidate.length} entities`, 'info');

        try {
          const analysisResult = await this.gitHistoryAgent.analyzeGitHistory({
            fromTimestamp: sinceDate.toISOString(),
            checkpoint_enabled: false
          });
          prefetchedCommits = analysisResult.commits || [];
          log(`Pre-fetched ${prefetchedCommits.length} commits for batch staleness detection`, 'info');
        } catch (error) {
          log(`Failed to pre-fetch git commits, will skip git-based validation`, 'warning', error);
        }
      }

      // Process entities in parallel batches with controlled concurrency
      // Use parallelWorkers setting (default 10, max 20) for concurrent validation
      const concurrencyLimit = Math.max(this.parallelWorkers, 3); // At least 3 for efficiency

      for (let i = 0; i < entitiesToValidate.length; i += concurrencyLimit) {
        const batch = entitiesToValidate.slice(i, i + concurrencyLimit);

        // Process batch in parallel
        const batchResults = await Promise.all(
          batch.map(async (entity, batchIndex) => {
            const entityName = entity.name || entity.entityName || entity.entity_name;
            const globalIndex = i + batchIndex;

            if (options?.progressCallback) {
              options.progressCallback(globalIndex + 1, entitiesToValidate.length, entityName);
            }

            try {
              // Pass prefetchedCommits to avoid per-entity git calls
              const report = await this.validateEntityAccuracy(entityName, team, prefetchedCommits);
              return { success: true, report, entityName };
            } catch (error) {
              log(`Error validating entity ${entityName}`, "error", error);
              return { success: false, report: null, entityName };
            }
          })
        );

        // Aggregate batch results
        for (const { success, report } of batchResults) {
          if (success && report) {
            result.validatedEntities++;
            if (!report.overallValid) {
              result.invalidEntities++;
              result.reports.push(report);
            } else if (!skipHealthy) {
              result.reports.push(report);
            }
          }
        }

        // Log progress for batches
        const processed = Math.min(i + concurrencyLimit, entitiesToValidate.length);
        log(`Validated ${processed}/${entitiesToValidate.length} entities for team ${team}`, "debug");
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      result.summary = `Validated ${result.validatedEntities}/${result.totalEntities} entities for team ${team} in ${elapsed}s. Found ${result.invalidEntities} invalid entities.`;

      log(result.summary, "info");

    } catch (error) {
      log(`Error during batch validation for team ${team}`, "error", error);
      result.summary = `Batch validation error: ${error instanceof Error ? error.message : String(error)}`;
    }

    return result;
  }

  /**
   * Validate all entities across all projects in the knowledge base
   * Returns aggregated validation results for the entire knowledge base
   */
  async validateAllEntities(options?: {
    maxEntitiesPerProject?: number;
    skipHealthyEntities?: boolean;
    progressCallback?: (team: string, current: number, total: number) => void;
  }): Promise<{
    validatedAt: string;
    totalProjects: number;
    totalEntities: number;
    totalInvalidEntities: number;
    projectResults: Map<string, {
      validatedEntities: number;
      invalidEntities: number;
      reports: EntityValidationReport[];
    }>;
    summary: string;
  }> {
    const startTime = Date.now();

    log("Starting full knowledge base validation", "info");

    const result = {
      validatedAt: new Date().toISOString(),
      totalProjects: 0,
      totalEntities: 0,
      totalInvalidEntities: 0,
      projectResults: new Map<string, {
        validatedEntities: number;
        invalidEntities: number;
        reports: EntityValidationReport[];
      }>(),
      summary: ""
    };

    try {
      // Find all project knowledge export files
      const knowledgeExportDir = path.join(this.repositoryPath, '.data', 'knowledge-export');
      const files = await this.findFilesInDirAsync(knowledgeExportDir, ['.json'], 1);

      const projectTeams = files
        .map(f => path.basename(f, '.json'))
        .filter(name => !name.startsWith('.') && name !== 'metadata');

      result.totalProjects = projectTeams.length;

      // OPTIMIZATION: Process projects in parallel (typically 1-3 projects)
      // Each project's entities are already processed in parallel batches internally
      const projectValidations = await Promise.all(
        projectTeams.map(async (team) => {
          if (options?.progressCallback) {
            options.progressCallback(team, 0, 0);
          }

          const projectResult = await this.validateEntitiesByProject(team, {
            maxEntities: options?.maxEntitiesPerProject,
            skipHealthyEntities: options?.skipHealthyEntities,
            progressCallback: options?.progressCallback
              ? (current, total, _entityName) => options.progressCallback!(team, current, total)
              : undefined
          });

          return { team, projectResult };
        })
      );

      // Aggregate results from parallel project validations
      for (const { team, projectResult } of projectValidations) {
        result.totalEntities += projectResult.validatedEntities;
        result.totalInvalidEntities += projectResult.invalidEntities;

        result.projectResults.set(team, {
          validatedEntities: projectResult.validatedEntities,
          invalidEntities: projectResult.invalidEntities,
          reports: projectResult.reports
        });
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      result.summary = `Full KB validation complete: ${result.totalProjects} projects, ${result.totalEntities} entities, ${result.totalInvalidEntities} invalid in ${elapsed}s`;

      log(result.summary, "info");

    } catch (error) {
      log("Error during full knowledge base validation", "error", error);
      result.summary = `Full KB validation error: ${error instanceof Error ? error.message : String(error)}`;
    }

    return result;
  }

  /**
   * Main entry point: Validate all content for an entity
   * @param entityName - Name of the entity to validate
   * @param team - Team/project namespace
   * @param prefetchedCommits - Optional pre-fetched git commits to avoid per-entity git calls (major performance optimization)
   */
  async validateEntityAccuracy(entityName: string, team: string, prefetchedCommits?: any[]): Promise<EntityValidationReport> {
    log(`Starting validation for entity: ${entityName}`, "info");

    const report: EntityValidationReport = {
      entityName,
      team,
      validatedAt: new Date().toISOString(),
      overallValid: true,
      overallScore: 100,
      totalIssues: 0,
      criticalIssues: 0,
      observationValidations: [],
      recommendations: [],
      suggestedActions: {
        removeObservations: [],
        updateObservations: [],
        regenerateDiagrams: [],
        refreshInsight: false,
      }
    };

    try {
      // Load entity from graph database (would be injected in practice)
      const entity = await this.loadEntity(entityName, team);

      if (!entity) {
        report.overallValid = false;
        report.recommendations.push(`Entity '${entityName}' not found in team '${team}'`);
        return report;
      }

      // Git-based staleness detection (primary mechanism)
      // Uses prefetchedCommits if provided to avoid expensive per-entity git calls
      if (this.useGitBasedDetection) {
        const gitStaleness = await this.detectEntityGitStaleness(entity, team, prefetchedCommits);
        report.gitStaleness = gitStaleness;

        if (gitStaleness.isStale) {
          report.overallValid = false;
          report.totalIssues += gitStaleness.invalidatingCommits.length;
          report.criticalIssues += 1; // Git-based staleness is critical

          // Add recommendation with specific commit info
          const commitCount = gitStaleness.invalidatingCommits.length;
          const topCorrelation = gitStaleness.correlations[0];
          report.recommendations.push(
            `Entity may be outdated: ${commitCount} commit(s) since last update may affect this entity. ` +
            `Top match via ${topCorrelation?.matchMethod}: ${topCorrelation?.matchDetails?.substring(0, 100) || 'N/A'}`
          );
        }
      }

      // Validate observations (file/command/component references)
      if (entity.observations && entity.observations.length > 0) {
        report.observationValidations = await this.validateObservations(entity.observations);

        for (const validation of report.observationValidations) {
          if (!validation.isValid) {
            report.overallValid = false;
            const criticalIssues = validation.issues.filter(i => i.type === "error");
            report.criticalIssues += criticalIssues.length;
            report.totalIssues += validation.issues.length;

            if (criticalIssues.length > 0) {
              report.suggestedActions.removeObservations.push(validation.observation);
            } else {
              report.suggestedActions.updateObservations.push(validation.observation);
            }
          }
        }
      }

      // Validate insight document if exists
      const insightPath = await this.findInsightDocument(entityName);
      if (insightPath) {
        report.insightValidation = await this.validateInsightDocument(insightPath);

        if (!report.insightValidation.isValid) {
          report.overallValid = false;
          report.totalIssues += report.insightValidation.issues.length;
          report.criticalIssues += report.insightValidation.issues.filter(i => i.type === "error").length;

          if (report.insightValidation.outdatedSections.length > 0) {
            report.suggestedActions.refreshInsight = true;
          }

          for (const diagramValidation of report.insightValidation.diagramValidations) {
            if (!diagramValidation.isValid) {
              report.suggestedActions.regenerateDiagrams.push(diagramValidation.diagramPath);
            }
          }
        }
      } else {
        // Check if entity should have an insight document (non-trivial entities)
        const requiresInsight = this.entityRequiresInsightDocument(entityName, entity);
        if (requiresInsight) {
          report.overallValid = false;
          report.totalIssues += 1;
          report.criticalIssues += 1;
          report.suggestedActions.refreshInsight = true;
          report.recommendations.push(
            `Entity '${entityName}' is non-trivial but missing insight document. ` +
            `Expected at: knowledge-management/insights/${entityName}.md`
          );
        }
      }

      // Calculate overall score
      report.overallScore = this.calculateValidationScore(report);

      // Generate recommendations
      report.recommendations = this.generateRecommendations(report);

      log(`Validation complete for ${entityName}`, "info", {
        overallValid: report.overallValid,
        overallScore: report.overallScore,
        totalIssues: report.totalIssues
      });

    } catch (error) {
      log(`Error validating entity ${entityName}`, "error", error);
      report.overallValid = false;
      report.recommendations.push(`Validation error: ${error}`);
    }

    return report;
  }

  /**
   * Validate individual observations for accuracy
   * Observations can be strings or objects with {type, content} structure
   */
  async validateObservations(observations: (string | { type?: string; content?: string })[]): Promise<ObservationValidation[]> {
    const validations: ObservationValidation[] = [];

    for (const obs of observations) {
      // Extract the text content from the observation
      // Handle both string observations and object observations with {type, content}
      const observationText = typeof obs === 'string'
        ? obs
        : (obs.content || JSON.stringify(obs));

      const validation: ObservationValidation = {
        observation: observationText,
        isValid: true,
        issues: [],
        extractedReferences: {
          files: [],
          commands: [],
          components: [],
          apis: []
        }
      };

      // Extract file references
      validation.extractedReferences.files = this.extractFileReferences(observationText);

      // Extract command references
      validation.extractedReferences.commands = this.extractCommandReferences(observationText);

      // Extract component references
      validation.extractedReferences.components = this.extractComponentReferences(observationText);

      // Validate file references exist
      for (const file of validation.extractedReferences.files) {
        const exists = await this.fileExists(file);
        if (!exists) {
          validation.isValid = false;
          validation.issues.push({
            type: "error",
            category: "file_reference",
            message: `Referenced file does not exist`,
            reference: file,
            suggestion: `Remove or update this file reference`
          });
        }
      }

      // Validate command references
      for (const command of validation.extractedReferences.commands) {
        const isValid = await this.validateCommandReference(command);
        if (!isValid) {
          validation.isValid = false;
          validation.issues.push({
            type: "error",
            category: "command_reference",
            message: `Referenced command is no longer valid`,
            reference: command,
            suggestion: `Update command reference or remove observation`
          });
        }
      }

      // Validate component references (check if classes exist in codebase)
      if (this.enableDeepValidation) {
        for (const component of validation.extractedReferences.components) {
          const exists = await this.componentExists(component);
          if (!exists) {
            validation.isValid = false;
            validation.issues.push({
              type: "warning",
              category: "component_reference",
              message: `Referenced component may not exist`,
              reference: component,
              suggestion: `Verify component exists or update reference`
            });
          }
        }
      }

      // NOTE: Pattern-based staleness detection removed in favor of git-based detection
      // Git-based detection is more accurate and self-maintaining (see detectEntityGitStaleness)

      validations.push(validation);
    }

    return validations;
  }

  /**
   * Validate insight document and its diagrams
   */
  async validateInsightDocument(insightPath: string): Promise<InsightValidation> {
    const validation: InsightValidation = {
      insightPath,
      isValid: true,
      issues: [],
      outdatedSections: [],
      diagramValidations: []
    };

    try {
      const insightExists = await this.fileExists(insightPath);
      if (!insightExists) {
        validation.isValid = false;
        validation.issues.push({
          type: "error",
          category: "file_reference",
          message: "Insight document does not exist",
          reference: insightPath
        });
        return validation;
      }

      const content = await fsPromises.readFile(insightPath, "utf-8");

      // Check for outdated patterns in content
      const outdatedPatterns = this.detectOutdatedPatterns(content);
      for (const pattern of outdatedPatterns) {
        validation.isValid = false;
        validation.issues.push({
          type: "warning",
          category: "observation_staleness",
          message: pattern.message,
          reference: pattern.reference,
          suggestion: pattern.suggestion
        });
        validation.outdatedSections.push(pattern.reference);
      }

      // Find and validate PlantUML diagrams
      const diagramReferences = this.extractDiagramReferences(content);
      const insightDir = path.dirname(insightPath);

      for (const diagramRef of diagramReferences) {
        const diagramPath = path.isAbsolute(diagramRef)
          ? diagramRef
          : path.join(insightDir, diagramRef);

        const diagramValidation = await this.validatePlantUMLDiagram(diagramPath, content);
        validation.diagramValidations.push(diagramValidation);

        if (!diagramValidation.isValid) {
          validation.isValid = false;
          validation.issues.push(...diagramValidation.issues);
        }
      }

    } catch (error) {
      validation.isValid = false;
      validation.issues.push({
        type: "error",
        category: "file_reference",
        message: `Error reading insight document: ${error}`,
        reference: insightPath
      });
    }

    return validation;
  }

  /**
   * Validate PlantUML diagrams for accuracy
   */
  async validatePlantUMLDiagram(diagramPath: string, insightContent?: string): Promise<DiagramValidation> {
    const validation: DiagramValidation = {
      diagramPath,
      isValid: true,
      issues: [],
      referencedComponents: [],
      missingComponents: []
    };

    try {
      // Check if .puml file exists (async)
      const pumlPath = diagramPath.replace(/\.png$/, ".puml");
      const pumlExists = await this.fileExists(pumlPath);
      const diagramExists = await this.fileExists(diagramPath);

      if (!pumlExists && !diagramExists) {
        validation.isValid = false;
        validation.issues.push({
          type: "error",
          category: "diagram_staleness",
          message: "Diagram file does not exist",
          reference: diagramPath,
          suggestion: "Regenerate the diagram"
        });
        return validation;
      }

      const diagramContent = pumlExists
        ? await fsPromises.readFile(pumlPath, "utf-8")
        : "";

      // Extract component names from PlantUML
      validation.referencedComponents = this.extractPlantUMLComponents(diagramContent);

      // Check if referenced components exist in codebase
      for (const component of validation.referencedComponents) {
        const exists = await this.componentExists(component);
        if (!exists) {
          validation.missingComponents.push(component);
        }
      }

      if (validation.missingComponents.length > 0) {
        validation.isValid = false;
        validation.issues.push({
          type: "warning",
          category: "diagram_staleness",
          message: `Diagram references ${validation.missingComponents.length} components that may not exist`,
          reference: diagramPath,
          suggestion: `Regenerate diagram. Missing: ${validation.missingComponents.join(", ")}`
        });
      }

      // Check for outdated naming patterns in diagram
      const outdatedDiagramPatterns = this.detectOutdatedPatternsInDiagram(diagramContent);
      for (const pattern of outdatedDiagramPatterns) {
        validation.isValid = false;
        validation.issues.push({
          type: "error",
          category: "diagram_staleness",
          message: pattern.message,
          reference: diagramPath,
          suggestion: pattern.suggestion
        });
      }

    } catch (error) {
      validation.isValid = false;
      validation.issues.push({
        type: "error",
        category: "diagram_staleness",
        message: `Error validating diagram: ${error}`,
        reference: diagramPath
      });
    }

    return validation;
  }

  /**
   * Generate refresh report with actionable recommendations
   */
  generateRefreshReport(report: EntityValidationReport): string {
    const lines: string[] = [
      `# Entity Validation Report: ${report.entityName}`,
      ``,
      `**Team:** ${report.team}`,
      `**Validated:** ${report.validatedAt}`,
      `**Overall Score:** ${report.overallScore}/100`,
      `**Status:** ${report.overallValid ? "VALID" : "NEEDS REFRESH"}`,
      ``,
    ];

    if (report.totalIssues > 0) {
      lines.push(`## Issues Found: ${report.totalIssues} (${report.criticalIssues} critical)`);
      lines.push(``);

      // Group issues by category
      const allIssues: ValidationIssue[] = [];
      for (const ov of report.observationValidations) {
        allIssues.push(...ov.issues);
      }
      if (report.insightValidation) {
        allIssues.push(...report.insightValidation.issues);
      }

      const byCategory = new Map<string, ValidationIssue[]>();
      for (const issue of allIssues) {
        const cat = issue.category;
        if (!byCategory.has(cat)) {
          byCategory.set(cat, []);
        }
        byCategory.get(cat)!.push(issue);
      }

      for (const [category, issues] of byCategory) {
        lines.push(`### ${category.replace(/_/g, " ").toUpperCase()}`);
        for (const issue of issues) {
          lines.push(`- [${issue.type.toUpperCase()}] ${issue.message}`);
          lines.push(`  - Reference: \`${issue.reference}\``);
          if (issue.suggestion) {
            lines.push(`  - Suggestion: ${issue.suggestion}`);
          }
        }
        lines.push(``);
      }
    }

    if (report.recommendations.length > 0) {
      lines.push(`## Recommendations`);
      for (const rec of report.recommendations) {
        lines.push(`- ${rec}`);
      }
      lines.push(``);
    }

    if (Object.values(report.suggestedActions).some(v =>
      Array.isArray(v) ? v.length > 0 : v)) {
      lines.push(`## Suggested Actions`);

      if (report.suggestedActions.removeObservations.length > 0) {
        lines.push(`### Remove Observations`);
        for (const obs of report.suggestedActions.removeObservations) {
          lines.push(`- "${obs.substring(0, 80)}${obs.length > 80 ? "..." : ""}"`);
        }
      }

      if (report.suggestedActions.updateObservations.length > 0) {
        lines.push(`### Update Observations`);
        for (const obs of report.suggestedActions.updateObservations) {
          lines.push(`- "${obs.substring(0, 80)}${obs.length > 80 ? "..." : ""}"`);
        }
      }

      if (report.suggestedActions.regenerateDiagrams.length > 0) {
        lines.push(`### Regenerate Diagrams`);
        for (const diag of report.suggestedActions.regenerateDiagrams) {
          lines.push(`- \`${diag}\``);
        }
      }

      if (report.suggestedActions.refreshInsight) {
        lines.push(`### Refresh Insight Document`);
        lines.push(`- Re-generate the insight document with current codebase state`);
      }
    }

    return lines.join("\n");
  }

  // ==================== Private Helper Methods ====================

  private async loadEntity(entityName: string, team: string): Promise<any> {
    // First try to load from graph database if available
    if (this.graphDB && this.graphDB.initialized) {
      try {
        // Use searchTerm for name matching (namePattern not supported by VKB API)
        const entities = await this.graphDB.queryEntities({
          searchTerm: entityName
        });
        // Find exact match and normalize field names (Phase 42.2 Plan 04 —
        // km-core Entity uses `name`/`entityType` directly; legacy entity_name
        // fields no longer occur but the cast preserves robustness against any
        // legacy fallback paths still feeding through `searchTerm`).
        const exactMatch = (entities as unknown as Array<Record<string, unknown>>)?.find((e) =>
          (e.name as string | undefined) === entityName
        );
        if (exactMatch) {
          const meta = (exactMatch.metadata ?? {}) as Record<string, unknown>;
          return {
            name: exactMatch.name as string,
            entityType: exactMatch.entityType as string | undefined,
            observations: (meta.observations as unknown[]) ?? (exactMatch.observations as unknown[]) ?? [],
            significance: exactMatch.significance,
            relationships: (exactMatch.relationships as unknown[]) ?? [],
            metadata: {
              ...meta,
              team: (meta.team as string | undefined) ?? team,
              last_updated:
                (meta.last_updated as string | undefined) ??
                (exactMatch.updatedAt as string | undefined) ??
                (exactMatch.validFrom as string | undefined),
            }
          };
        }
      } catch (error) {
        log(`Error loading entity from graph database, falling back to file`, "warning", error);
      }
    }

    // Fallback: read from the knowledge export file (async)
    const knowledgeExportPath = path.join(
      this.repositoryPath,
      '.data',
      'knowledge-export',
      `${team}.json`
    );

    try {
      await fsPromises.access(knowledgeExportPath, fs.constants.F_OK);
      const content = JSON.parse(await fsPromises.readFile(knowledgeExportPath, "utf-8"));
      return content.entities?.find((e: any) => e.name === entityName);
    } catch (error) {
      // File doesn't exist or can't be read
      log(`Error loading entity from knowledge export`, "error", error);
    }

    return null;
  }

  private extractFileReferences(text: string): string[] {
    const files = new Set<string>();

    for (const pattern of this.filePathPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const filePath = match[1];
        if (filePath && !filePath.includes("*") && !filePath.includes("{")) {
          files.add(filePath);
        }
      }
    }

    return Array.from(files);
  }

  private extractCommandReferences(text: string): string[] {
    const commands = new Set<string>();

    for (const pattern of this.commandPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const command = match[1];
        if (command) {
          commands.add(command.toLowerCase());
        }
      }
    }

    return Array.from(commands);
  }

  private extractComponentReferences(text: string): string[] {
    const components = new Set<string>();

    for (const pattern of this.componentPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const component = match[1];
        if (component) {
          components.add(component);
        }
      }
    }

    return Array.from(components);
  }

  private extractDiagramReferences(content: string): string[] {
    const diagrams = new Set<string>();

    // Match markdown image references
    const imgPattern = /!\[.*?\]\(([^)]+\.(?:png|puml))\)/gi;
    let match;
    while ((match = imgPattern.exec(content)) !== null) {
      diagrams.add(match[1]);
    }

    // Match PlantUML include patterns
    const includePattern = /!include\s+([^\s]+\.puml)/gi;
    while ((match = includePattern.exec(content)) !== null) {
      diagrams.add(match[1]);
    }

    return Array.from(diagrams);
  }

  private extractPlantUMLComponents(content: string): string[] {
    const components = new Set<string>();

    // Extract class/component names from PlantUML
    const patterns = [
      /class\s+"?([^"\s{]+)"?\s*{?/gi,           // class ClassName
      /component\s+"?([^"\s]+)"?/gi,             // component ComponentName
      /participant\s+"?([^"\s]+)"?/gi,           // participant Name
      /actor\s+"?([^"\s]+)"?/gi,                 // actor Name
      /database\s+"?([^"\s]+)"?/gi,              // database Name
      /node\s+"?([^"\s]+)"?/gi,                  // node Name
      /package\s+"?([^"\s{]+)"?\s*{?/gi,         // package Name
      /rectangle\s+"?([^"\s{]+)"?\s*{?/gi,       // rectangle Name
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const name = match[1];
        if (name && !name.startsWith("@") && !name.startsWith("#")) {
          components.add(name);
        }
      }
    }

    return Array.from(components);
  }

  private async fileExists(filePath: string): Promise<boolean> {
    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.repositoryPath, filePath);
    try {
      await fsPromises.access(fullPath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async validateCommandReference(command: string): Promise<boolean> {
    // Known deprecated/removed commands
    const deprecatedCommands = ["ukb"];

    if (deprecatedCommands.includes(command.toLowerCase())) {
      return false;
    }

    // Known valid commands
    const validCommands = ["vkb", "coding", "claude-mcp"];
    if (validCommands.includes(command.toLowerCase())) {
      return true;
    }

    // Check if command exists in bin/ or scripts/
    const binPath = path.join(this.repositoryPath, "bin", command);
    const scriptsPath = path.join(this.repositoryPath, "scripts", `${command}.js`);

    try {
      await fsPromises.access(binPath, fs.constants.F_OK);
      return true;
    } catch {
      try {
        await fsPromises.access(scriptsPath, fs.constants.F_OK);
        return true;
      } catch {
        return false;
      }
    }
  }

  private async componentExists(componentName: string): Promise<boolean> {
    // Search for the component in known directories
    try {
      const searchDirs = ['src', 'lib', 'scripts', 'integrations'];
      const classPattern = `class ${componentName}`;

      for (const dir of searchDirs) {
        const dirPath = path.join(this.repositoryPath, dir);

        // Check if directory exists (async)
        try {
          await fsPromises.access(dirPath, fs.constants.F_OK);
        } catch {
          continue;
        }

        // Check if a file with the component name exists
        const componentFile = path.join(dirPath, `${componentName.toLowerCase()}.ts`);
        const componentFileJs = path.join(dirPath, `${componentName.toLowerCase()}.js`);

        try {
          await fsPromises.access(componentFile, fs.constants.F_OK);
          return true;
        } catch {
          try {
            await fsPromises.access(componentFileJs, fs.constants.F_OK);
            return true;
          } catch {
            // Continue searching
          }
        }

        // Recursively search for class definition in immediate .ts/.js files
        const files = await this.findFilesInDirAsync(dirPath, ['.ts', '.js'], 2);
        for (const file of files.slice(0, 50)) { // Limit search
          try {
            const content = await fsPromises.readFile(file, "utf-8");
            if (content.includes(classPattern)) {
              return true;
            }
          } catch {
            // Skip unreadable files
          }
        }
      }

      return false;
    } catch {
      return true; // Assume exists if search fails
    }
  }

  /**
   * Async recursive file finder (limited depth) - non-blocking version
   */
  private async findFilesInDirAsync(dir: string, extensions: string[], maxDepth: number, currentDepth: number = 0): Promise<string[]> {
    if (currentDepth > maxDepth) return [];

    const files: string[] = [];
    try {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Skip node_modules, dist, .git
          if (['node_modules', 'dist', '.git', '.data'].includes(entry.name)) continue;
          const subFiles = await this.findFilesInDirAsync(fullPath, extensions, maxDepth, currentDepth + 1);
          files.push(...subFiles);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (extensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }

      // Yield to event loop periodically to prevent blocking
      if (files.length > 0 && files.length % 20 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    } catch {
      // Skip unreadable directories
    }

    return files;
  }

  private detectOutdatedPatterns(content: string): Array<{message: string, reference: string, suggestion: string}> {
    const issues: Array<{message: string, reference: string, suggestion: string}> = [];

    // Known outdated patterns - comprehensive list
    const outdatedPatterns = [
      {
        pattern: /\bu[kK][bB]\b/gi,
        message: "References deprecated 'ukb' command",
        suggestion: "Use MCP semantic-analysis execute_workflow with 'incremental-analysis'"
      },
      {
        pattern: /`u[kK][bB]`/gi,
        message: "References deprecated command in code block",
        suggestion: "Use MCP semantic-analysis execute_workflow"
      },
      {
        pattern: /shared-memory\.json/gi,
        message: "References shared-memory.json (deprecated)",
        suggestion: "Use GraphDB persistence via MCP tools"
      },
      {
        pattern: /shared-memory-\w+\.json/gi,
        message: "References shared-memory JSON files (deprecated)",
        suggestion: "Update to reference Graphology + LevelDB storage"
      },
      {
        pattern: /SynchronizationAgent/gi,
        message: "References SynchronizationAgent (removed)",
        suggestion: "Use GraphDatabaseAdapter for persistence"
      },
      {
        pattern: /json-based.*persistence/gi,
        message: "References JSON-based persistence (deprecated)",
        suggestion: "Update to reference graph database persistence"
      },
      {
        pattern: /existing\s+shared-memory/gi,
        message: "References existing shared-memory format (deprecated)",
        suggestion: "Update to reference GraphDB + JSON export sync"
      },
    ];

    for (const {pattern, message, suggestion} of outdatedPatterns) {
      const match = pattern.exec(content);
      if (match) {
        issues.push({
          message,
          reference: match[0],
          suggestion
        });
      }
    }

    return issues;
  }

  private detectOutdatedPatternsInDiagram(content: string): Array<{message: string, suggestion: string}> {
    const issues: Array<{message: string, suggestion: string}> = [];

    // Check for deprecated components in diagrams
    const deprecatedComponents = [
      { name: "SynchronizationAgent", message: "Diagram shows removed SynchronizationAgent" },
      { name: "shared-memory", message: "Diagram references deprecated shared-memory files" },
      { name: "ukb", message: "Diagram references deprecated ukb command" },
    ];

    for (const {name, message} of deprecatedComponents) {
      if (content.toLowerCase().includes(name.toLowerCase())) {
        issues.push({
          message,
          suggestion: `Regenerate diagram to reflect current architecture`
        });
      }
    }

    return issues;
  }

  private async findInsightDocument(entityName: string): Promise<string | null> {
    // Convert entity name to filename format (kebab-case)
    const kebabFilename = entityName
      .replace(/([a-z])([A-Z])/g, "$1-$2")
      .toLowerCase()
      .replace(/\s+/g, "-");

    // Check multiple naming conventions for insight documents
    const possiblePaths = [
      // PascalCase (common for patterns/entities)
      path.join(this.insightsDirectory, `${entityName}.md`),
      // kebab-case
      path.join(this.insightsDirectory, `${kebabFilename}.md`),
      path.join(this.insightsDirectory, `${kebabFilename}-insight.md`),
      // Subdirectory variants
      path.join(this.insightsDirectory, entityName, `${kebabFilename}.md`),
      path.join(this.insightsDirectory, entityName, `${entityName}.md`),
    ];

    for (const p of possiblePaths) {
      const exists = await this.fileExists(p);
      if (exists) {
        return p;
      }
    }

    return null;
  }

  /**
   * Determine if an entity is non-trivial and should have an insight document.
   *
   * Non-trivial entities are those with:
   * - EntityType containing "Pattern", "Workflow", "Architecture", "System"
   * - Multiple observations (3+)
   * - Observations with architectural/design content
   */
  private entityRequiresInsightDocument(entityName: string, entity: any): boolean {
    // Entity types that typically require insight documents
    const significantTypePatterns = [
      /pattern/i,
      /workflow/i,
      /architecture/i,
      /system/i,
      /integration/i,
      /cli$/i,  // CLI tools are significant
      /agent/i,  // Agents are significant
    ];

    const entityType = entity?.entityType || entity?.type || '';
    const hasSignificantType = significantTypePatterns.some(p => p.test(entityType));

    // Check entity name for significance indicators
    const hasSignificantName = significantTypePatterns.some(p => p.test(entityName));

    // Check observation count - entities with many observations are non-trivial
    const observations = entity?.observations || [];
    const hasMultipleObservations = observations.length >= 3;

    // Check observation content for architectural keywords
    const architecturalKeywords = [
      'architecture', 'pattern', 'design', 'implementation',
      'workflow', 'integration', 'system', 'component',
      'layer', 'module', 'service', 'agent'
    ];

    const hasArchitecturalContent = observations.some((obs: any) => {
      const text = typeof obs === 'string' ? obs : (obs.content || '');
      return architecturalKeywords.some(keyword =>
        text.toLowerCase().includes(keyword)
      );
    });

    // Entity requires insight if it's significant type/name OR has substantial content
    return (hasSignificantType || hasSignificantName) ||
           (hasMultipleObservations && hasArchitecturalContent);
  }

  private calculateValidationScore(report: EntityValidationReport): number {
    // Start with 100 and deduct based on issues
    let score = 100;

    // Git-based staleness has significant weight (primary detection mechanism)
    if (report.gitStaleness?.isStale) {
      // Use the staleness score directly (0-100, lower = more stale)
      // Weight it at 40% of total score
      const gitPenalty = (100 - report.gitStaleness.stalenessScore) * 0.4;
      score -= gitPenalty;
    }

    // Deduct for critical issues
    score -= report.criticalIssues * 10;

    // Deduct for non-critical issues
    const nonCritical = report.totalIssues - report.criticalIssues;
    score -= nonCritical * 3;

    // Deduct for suggested actions
    score -= report.suggestedActions.removeObservations.length * 5;
    score -= report.suggestedActions.regenerateDiagrams.length * 5;
    if (report.suggestedActions.refreshInsight) {
      score -= 10;
    }

    return Math.max(0, Math.min(100, score));
  }

  private generateRecommendations(report: EntityValidationReport): string[] {
    const recommendations: string[] = [];

    if (report.criticalIssues > 0) {
      recommendations.push(
        `CRITICAL: ${report.criticalIssues} critical issues found. Entity content may be significantly outdated.`
      );
    }

    if (report.suggestedActions.removeObservations.length > 0) {
      recommendations.push(
        `Remove ${report.suggestedActions.removeObservations.length} outdated observations that reference non-existent resources`
      );
    }

    if (report.suggestedActions.regenerateDiagrams.length > 0) {
      recommendations.push(
        `Regenerate ${report.suggestedActions.regenerateDiagrams.length} PlantUML diagrams with current architecture`
      );
    }

    if (report.suggestedActions.refreshInsight) {
      recommendations.push(
        `Re-generate insight document to reflect current codebase state`
      );
    }

    if (report.overallScore < 50) {
      recommendations.push(
        `Entity requires comprehensive refresh. Consider running 'entity-refresh' workflow.`
      );
    } else if (report.overallScore < 80) {
      recommendations.push(
        `Entity has moderate staleness. Review and update flagged items.`
      );
    }

    return recommendations;
  }

  /**
   * Normalize entity name by removing version numbers and numeric identifiers
   * Follows CLAUDE.md "no version numbers" principle
   *
   * Examples:
   * - "SemanticAnalysis8AgentSystem" → "SemanticAnalysisAgentSystem"
   * - "PatternV2" → "Pattern"
   * - "OAuth2Integration" → "OAuth2Integration" (meaningful number, kept)
   */
  private normalizeEntityName(entityName: string): {
    needsNormalization: boolean;
    normalizedName: string;
    reason?: string;
  } {
    let normalized = entityName;
    let reason: string | undefined;

    // Pattern 1: Standalone numbers before words (e.g., "8AgentSystem" → "AgentSystem")
    // But keep meaningful protocol numbers like OAuth2, HTTP2, etc.
    const protocolNumbers = ['oauth2', 'http2', 'tls1', 'sha256', 'sha512', 'md5', 'base64', 'utf8', 'ipv4', 'ipv6'];
    const lowerName = normalized.toLowerCase();
    const hasProtocolNumber = protocolNumbers.some(p => lowerName.includes(p));

    if (!hasProtocolNumber) {
      // Remove numbers that appear to be version/count indicators
      // Pattern: number followed by capital letter (e.g., "8Agent", "10System", "Analysis8Agent")
      // These are count indicators, NOT semantic parts like "Level3" or "Phase1"
      const countWords = ['agent', 'system', 'pattern', 'implementation', 'service', 'component', 'module', 'layer', 'stage', 'step', 'tier'];
      const beforeMatch = normalized.match(/^(.*?)(\d+)([A-Z][a-zA-Z]+)(.*)$/);
      if (beforeMatch) {
        const [, prefix, num, word, suffix] = beforeMatch;
        const wordLower = word.toLowerCase();
        // Remove if the number is followed by a count-like word (Agent, System, etc.)
        // OR if there's no prefix (pure number prefix like "8AgentSystem")
        // OR if the number is large (>4) suggesting it's a count not a name part
        const isCountWord = countWords.some(cw => wordLower.startsWith(cw));
        const isLargeNumber = parseInt(num, 10) > 4;
        if (prefix === '' || isCountWord || isLargeNumber) {
          normalized = prefix + word + suffix;
          reason = `Removed numeric identifier '${num}' from entity name`;
        }
      }

      // Pattern 2: Version suffixes (e.g., "PatternV2", "SystemV3")
      const versionMatch = normalized.match(/^(.+?)[Vv](\d+)$/);
      if (versionMatch) {
        normalized = versionMatch[1];
        reason = `Removed version suffix 'V${versionMatch[2]}' from entity name`;
      }

      // Pattern 3: Numbers at end of name with no semantic meaning (e.g., "Agent8", "System10")
      // Be careful not to strip meaningful endings
      const endNumberMatch = normalized.match(/^(.+[a-zA-Z])(\d+)$/);
      if (endNumberMatch) {
        const [, base, num] = endNumberMatch;
        // Only remove trailing numbers if they look like counts (more than 1 digit or > 4)
        if (num.length > 1 || parseInt(num, 10) > 4) {
          normalized = base;
          reason = reason || `Removed trailing number '${num}' from entity name`;
        }
      }
    }

    const needsNormalization = normalized !== entityName;
    return {
      needsNormalization,
      normalizedName: normalized,
      reason
    };
  }

  /**
   * Refresh a stale entity by regenerating observations using LLM
   *
   * This method:
   * 1. Runs validation if not already provided
   * 2. Uses LLM to generate replacement observations for stale ones
   * 3. Calls PersistenceAgent.updateEntityObservations() to persist changes
   * 4. Returns refresh result with before/after comparison
   */
  async refreshStaleEntity(params: {
    entityName: string;
    team: string;
    validationReport?: EntityValidationReport;
    regenerateDiagrams?: boolean;
    regenerateInsight?: boolean;
    forceFullRefresh?: boolean;
    checkEntityName?: boolean;  // Normalize entity names (remove version numbers)
  }): Promise<EntityRefreshResult> {
    const startTime = Date.now();
    log(`Starting entity refresh for: ${params.entityName}`, 'info', {
      team: params.team,
      hasExistingReport: !!params.validationReport,
      forceFullRefresh: params.forceFullRefresh
    });

    const result: EntityRefreshResult = {
      entityName: params.entityName,
      team: params.team,
      refreshedAt: new Date().toISOString(),
      validationBefore: params.validationReport || {
        entityName: params.entityName,
        team: params.team,
        validatedAt: '',
        overallValid: true,
        overallScore: 100,
        totalIssues: 0,
        criticalIssues: 0,
        observationValidations: [],
        recommendations: [],
        suggestedActions: {
          removeObservations: [],
          updateObservations: [],
          regenerateDiagrams: [],
          refreshInsight: false
        }
      },
      observationChanges: {
        removed: [],
        added: [],
        unchanged: 0
      },
      diagramsRegenerated: [],
      insightRefreshed: false,
      success: false
    };

    try {
      // Step 1: Run validation if not provided (skip for force full refresh)
      if (!params.validationReport && !params.forceFullRefresh) {
        log('Running validation for entity', 'info');
        result.validationBefore = await this.validateEntityAccuracy(params.entityName, params.team);
      }

      // Check if entity needs refresh (per design decision: any score < 100)
      // Skip this check entirely when forceFullRefresh is true
      if (!params.forceFullRefresh && result.validationBefore.overallScore >= 100) {
        log('Entity is already up-to-date, no refresh needed', 'info');
        result.success = true;
        return result;
      }

      // Step 2: Check if km-core adapter is available
      if (!this.persistenceAgent) {
        result.error = 'km-core adapter not set. Call setKmCoreAdapter() first.';
        log(result.error, 'error');
        return result;
      }

      // Step 3: Load entity to get current observations
      let entity = await this.loadEntity(params.entityName, params.team);
      if (!entity) {
        result.error = `Entity '${params.entityName}' not found in team '${params.team}'`;
        log(result.error, 'error');
        return result;
      }

      // Step 3.5: Check entity name normalization (remove version numbers per CLAUDE.md)
      const shouldCheckName = params.checkEntityName ?? params.forceFullRefresh;
      if (shouldCheckName && this.persistenceAgent) {
        const nameCheck = this.normalizeEntityName(params.entityName);
        if (nameCheck.needsNormalization) {
          log(`Entity name needs normalization: ${params.entityName} -> ${nameCheck.normalizedName}`, 'info', {
            reason: nameCheck.reason
          });

          // Rename the entity (Phase 42.2 Plan 04 — adapter.renameEntity
          // takes insightsDir as a param since the adapter is repo-agnostic).
          const renameResult = await this.persistenceAgent.renameEntity({
            oldName: params.entityName,
            newName: nameCheck.normalizedName,
            team: params.team,
            insightsDir: this.insightsDirectory,
          });

          if (renameResult.success) {
            result.renamedFrom = params.entityName;
            result.renamedTo = nameCheck.normalizedName;
            result.cleanedUpFiles = renameResult.deletedFiles;

            // Update params and result for rest of flow
            params.entityName = nameCheck.normalizedName;
            result.entityName = nameCheck.normalizedName;

            // Reload entity with new name
            entity = await this.loadEntity(params.entityName, params.team);
            if (!entity) {
              result.error = `Entity '${params.entityName}' not found after rename`;
              log(result.error, 'error');
              return result;
            }

            log(`Entity renamed successfully`, 'info', {
              from: result.renamedFrom,
              to: result.renamedTo,
              migratedFiles: renameResult.migratedFiles.length
            });
          } else {
            log(`Entity rename failed: ${renameResult.details}`, 'warning');
          }
        }
      }

      // Step 4: Identify stale observations to remove
      let allStaleObservations: string[] = [];

      // FORCE FULL REFRESH: Treat ALL observations as stale, regenerate from scratch
      if (params.forceFullRefresh) {
        log('Force full refresh - treating ALL observations as stale for complete regeneration', 'info', {
          entityName: params.entityName,
          observationCount: entity.observations?.length || 0,
          hadValidationReport: !!params.validationReport
        });

        // Mark artificial score to indicate full refresh
        result.validationBefore.overallScore = 0;
        result.validationBefore.overallValid = false;

        // Force insight refresh when doing full refresh
        // Ensure suggestedActions exists (defensive)
        if (!result.validationBefore.suggestedActions) {
          result.validationBefore.suggestedActions = {
            removeObservations: [],
            updateObservations: [],
            regenerateDiagrams: [],
            refreshInsight: false
          };
        }
        result.validationBefore.suggestedActions.refreshInsight = true;

        log('Force full refresh flags set', 'debug', {
          refreshInsight: result.validationBefore.suggestedActions.refreshInsight,
          overallScore: result.validationBefore.overallScore
        });

        // Extract all current observations as stale
        allStaleObservations = (entity.observations || []).map((obs: string | { type?: string; content?: string }) =>
          typeof obs === 'string' ? obs : (obs.content || JSON.stringify(obs))
        );
      } else {
        // Normal mode: Check explicit stale observations from validation
        const observationsToRemove = result.validationBefore.suggestedActions.removeObservations;
        const observationsToUpdate = result.validationBefore.suggestedActions.updateObservations;
        allStaleObservations = [...observationsToRemove, ...observationsToUpdate];

        // If git-based staleness is detected but no specific observations flagged,
        // treat ALL observations as stale since the entity's context has changed
        if (allStaleObservations.length === 0 && result.validationBefore.gitStaleness?.isStale) {
          log('Git staleness detected - treating all observations as stale for regeneration', 'info', {
            stalenessScore: result.validationBefore.gitStaleness.stalenessScore,
            invalidatingCommits: result.validationBefore.gitStaleness.invalidatingCommits.length
          });

          // Extract all current observations as stale
          allStaleObservations = (entity.observations || []).map((obs: string | { type?: string; content?: string }) =>
            typeof obs === 'string' ? obs : (obs.content || JSON.stringify(obs))
          );
        }
      }

      if (allStaleObservations.length === 0) {
        log('No stale observations found to refresh', 'info');
        result.success = true;
        return result;
      }

      log(`Found ${allStaleObservations.length} stale observations to refresh`, 'info');

      // Step 5: Use LLM to generate replacement observations
      const newObservations = await this.generateReplacementObservations(
        params.entityName,
        entity,
        allStaleObservations,
        result.validationBefore
      );

      log(`Generated ${newObservations.length} replacement observations`, 'info');

      // Step 6: Update entity through PersistenceAgent
      const updateResult = await this.persistenceAgent.updateEntityObservations({
        entityName: params.entityName,
        team: params.team,
        removeObservations: allStaleObservations,
        newObservations: newObservations
      });

      if (!updateResult.success) {
        result.error = `Failed to update entity: ${updateResult.details}`;
        log(result.error, 'error');
        return result;
      }

      result.observationChanges = {
        removed: allStaleObservations,
        added: newObservations.map(obs => typeof obs === 'string' ? obs : obs.content),
        unchanged: entity.observations.length - allStaleObservations.length
      };

      // Step 6.5: Generate/refresh insight document and diagrams if needed
      const shouldRefreshInsight = params.forceFullRefresh ||
        params.regenerateInsight ||
        result.validationBefore.suggestedActions.refreshInsight;

      const shouldRegenerateDiagrams = params.forceFullRefresh ||
        params.regenerateDiagrams ||
        (result.validationBefore.suggestedActions.regenerateDiagrams?.length || 0) > 0;

      // Check if entity requires insight document (non-trivial entities)
      const requiresInsight = this.entityRequiresInsightDocument(params.entityName, entity);

      if ((shouldRefreshInsight || shouldRegenerateDiagrams) && requiresInsight) {
        log('Processing insight document and diagrams', 'info', {
          shouldRefreshInsight,
          shouldRegenerateDiagrams,
          requiresInsight
        });

        try {
          // Initialize InsightGenerationAgent if not already set
          if (!this.insightGenerationAgent) {
            const { InsightGenerationAgent } = await import('./insight-generation-agent.js');
            this.insightGenerationAgent = new InsightGenerationAgent(this.repositoryPath);
          }

          // Build current analysis context for insight generation
          // Include BOTH unchanged observations AND new observations for complete insight
          const unchangedObservations = (entity.observations || [])
            .filter((obs: string | { content?: string }) => {
              const obsContent = typeof obs === 'string' ? obs : (obs.content || '');
              return !allStaleObservations.includes(obsContent);
            })
            .map((obs: string | { content?: string; type?: string }) => ({
              type: typeof obs === 'object' && obs.type ? obs.type : 'retained',
              content: typeof obs === 'string' ? obs : (obs.content || ''),
              date: new Date().toISOString(),
              metadata: { source: 'retained-observation' }
            }));

          // Combine unchanged + new observations for full context
          const allObservationsForInsight = [...unchangedObservations, ...newObservations];
          log(`Building insight with ${unchangedObservations.length} unchanged + ${newObservations.length} new observations`, 'info');

          const currentAnalysis = await this.buildInsightAnalysisContext(params.entityName, entity, allObservationsForInsight);

          // Call refreshEntityInsights with proper parameters
          // When forceFullRefresh, generate ALL diagram types (architecture, sequence, class, use-cases)
          const insightResult = await this.insightGenerationAgent.refreshEntityInsights({
            validation_report: result.validationBefore,
            current_analysis: currentAnalysis,
            entityName: params.entityName,
            regenerate_diagrams: shouldRegenerateDiagrams,
            regenerate_all_diagrams: params.forceFullRefresh  // Generate all 4 diagram types
          });

          if (insightResult.success) {
            result.diagramsRegenerated = insightResult.regeneratedDiagrams;
            result.insightRefreshed = !!insightResult.refreshedInsightPath;

            // Add insight path as observation if it was generated
            if (insightResult.refreshedInsightPath) {
              // Convert absolute path to relative path for frontend compatibility
              // The VKB server serves /knowledge-management/* routes from the coding root
              const relativePath = insightResult.refreshedInsightPath.startsWith(this.repositoryPath)
                ? insightResult.refreshedInsightPath.slice(this.repositoryPath.length + 1) // +1 for trailing slash
                : insightResult.refreshedInsightPath;

              const insightObservation = {
                type: 'insight-document',
                content: `Detailed insight document available at: ${relativePath}`,
                date: new Date().toISOString(),
                metadata: {
                  insightPath: relativePath,
                  absolutePath: insightResult.refreshedInsightPath, // Keep absolute for debugging
                  diagramsGenerated: insightResult.regeneratedDiagrams.length,
                  generatedBy: 'entity-refresh'
                }
              };

              // Add the insight observation to the entity
              await this.persistenceAgent.updateEntityObservations({
                entityName: params.entityName,
                team: params.team,
                removeObservations: [],
                newObservations: [insightObservation]
              });

              result.observationChanges.added.push(insightObservation.content);
            }

            log('Insight document and diagrams processed', 'info', {
              insightPath: insightResult.refreshedInsightPath,
              diagramsRegenerated: insightResult.regeneratedDiagrams.length
            });
          } else {
            log('Insight refresh completed with issues', 'warning', {
              summary: insightResult.summary
            });
          }
        } catch (insightError) {
          // Don't fail the entire refresh if insight generation fails
          log('Insight/diagram generation failed (non-fatal)', 'warning', insightError);
        }
      }

      // Step 7: Re-validate to confirm improvements
      result.validationAfter = await this.validateEntityAccuracy(params.entityName, params.team);

      result.success = true;
      const duration = Date.now() - startTime;
      log(`Entity refresh completed successfully`, 'info', {
        entityName: params.entityName,
        scoreBefore: result.validationBefore.overallScore,
        scoreAfter: result.validationAfter.overallScore,
        observationsRemoved: result.observationChanges.removed.length,
        observationsAdded: result.observationChanges.added.length,
        durationMs: duration
      });

      return result;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.error = `Entity refresh failed: ${errorMessage}`;
      log(result.error, 'error', error);
      return result;
    }
  }

  /**
   * Generate replacement observations by running ACTUAL CODEBASE ANALYSIS
   *
   * This method runs the full analysis pipeline to understand the current
   * state of the codebase, then generates accurate observations based on
   * real data - NOT by asking an LLM to guess.
   *
   * Analysis steps:
   * 1. Run git history analysis for relevant commits
   * 2. Run vibe/LSL history analysis for relevant conversations
   * 3. Scan codebase for actual file paths, commands, and components
   * 4. Generate observations from verified codebase facts
   */
  private async generateReplacementObservations(
    entityName: string,
    entity: any,
    staleObservations: string[],
    validationReport: EntityValidationReport
  ): Promise<Array<{ type: string; content: string; date: string; metadata: Record<string, any> }>> {
    const newObservations: Array<{ type: string; content: string; date: string; metadata: Record<string, any> }> = [];
    const now = new Date().toISOString();

    log(`Running FULL CODEBASE ANALYSIS for entity refresh: ${entityName}`, 'info', {
      staleObservationsCount: staleObservations.length
    });

    try {
      // Initialize analysis agents if not already done
      this.initializeAnalysisAgents();

      // Step 1: Extract search terms from entity name and existing observations
      const searchTerms = this.extractSearchTerms(entityName, entity, staleObservations);
      log('Extracted search terms for analysis', 'debug', { searchTerms });

      // Step 2: Run git history analysis to find relevant recent commits
      let gitAnalysisResults: any = null;
      if (this.gitHistoryAgent) {
        try {
          // Analyze commits from the last 90 days
          gitAnalysisResults = await this.gitHistoryAgent.analyzeGitHistory({
            incremental: false, // Full analysis for entity refresh
            days: 90
          });
          log('Git analysis completed', 'info', {
            commitsAnalyzed: gitAnalysisResults?.commits?.length || 0
          });
        } catch (gitError) {
          log('Git analysis failed, continuing with other sources', 'warning', gitError);
        }
      }

      // Step 3: Run vibe/LSL history analysis for relevant conversations
      let vibeAnalysisResults: any = null;
      if (this.vibeHistoryAgent) {
        try {
          vibeAnalysisResults = await this.vibeHistoryAgent.analyzeVibeHistory({
            incremental: false, // Full analysis for entity refresh
            days: 90
          });
          log('Vibe history analysis completed', 'info', {
            sessionsAnalyzed: vibeAnalysisResults?.sessions?.length || 0
          });
        } catch (vibeError) {
          log('Vibe analysis failed, continuing with other sources', 'warning', vibeError);
        }
      }

      // Step 4: Scan codebase for current state - VERIFY what actually exists
      const codebaseState = await this.scanCodebaseForEntityReferences(entityName, searchTerms);
      log('Codebase scan completed', 'info', {
        existingFiles: codebaseState.existingFiles.length,
        existingCommands: codebaseState.existingCommands.length,
        existingComponents: codebaseState.existingComponents.length
      });

      // Step 5: Build comprehensive context from REAL analysis data
      const analysisContext = this.buildAnalysisContext(
        entityName,
        entity,
        staleObservations,
        validationReport,
        gitAnalysisResults,
        vibeAnalysisResults,
        codebaseState
      );

      // Step 6: Generate observations using LLM but with REAL codebase facts
      const contextPrompt = `You are generating ACCURATE observations for the knowledge entity "${entityName}".

CRITICAL: You must ONLY generate observations based on the VERIFIED CODEBASE STATE provided below.
DO NOT invent or assume any technical details that are not in the provided context.

## Entity Information
- Name: ${entityName}
- Type: ${entity.entityType || 'Unknown'}
- Tags: ${(entity.tags || []).join(', ')}

## VERIFIED CODEBASE STATE (from actual codebase scan)
${analysisContext.codebaseFacts}

## Recent Git Activity (actual commits)
${analysisContext.gitContext || 'No recent git activity found'}

## Recent Conversations/Sessions (from LSL history)
${analysisContext.vibeContext || 'No recent conversation context found'}

## Issues Found with Current Observations
${analysisContext.issuesSummary}

## Stale Observations to Replace
${staleObservations.map((obs, i) => `${i + 1}. ${obs}`).join('\n')}

Generate ${staleObservations.length} replacement observations that:
1. Are 100% accurate based on the verified codebase state above
2. Reference only files, commands, and components that ACTUALLY EXIST
3. Use correct command names (vkb for visualization, MCP tools for knowledge operations)
4. Describe the CURRENT architecture, not historical or assumed patterns
5. Include specific file paths and component names from the verified state

Respond with a JSON array:
[
  {
    "type": "rule|implementation|validation|workflow|benefits|architecture",
    "content": "Accurate observation based on verified codebase state",
    "confidence": 0.9
  }
]`;

      const result = await this.semanticAnalyzer.analyzeContent(contextPrompt, {
        analysisType: 'code',
        provider: 'auto'
      });

      // Parse LLM response
      let parsedObservations: Array<{ type: string; content: string; confidence: number }> = [];
      try {
        const jsonMatch = result.insights.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          parsedObservations = JSON.parse(jsonMatch[0]);
        }
      } catch (parseError) {
        log('Failed to parse LLM response as JSON', 'warning', parseError);
      }

      if (parsedObservations.length > 0) {
        // Filter out LLM-generated observations that reference insight documents
        // The system adds its own insight-document observation with the correct path
        const insightDocPatterns = [
          /detailed\s+insight/i,
          /insight\s+document/i,
          /knowledge-management\/insights\//i,
          /insights\/.*\.md/i
        ];

        const filteredObservations = parsedObservations.filter(obs => {
          const content = obs.content || '';
          const matchesInsightPattern = insightDocPatterns.some(pattern => pattern.test(content));
          if (matchesInsightPattern) {
            log(`Filtering out LLM-generated insight document reference: ${content.substring(0, 80)}...`, 'debug');
            return false;
          }
          return true;
        });

        for (const obs of filteredObservations) {
          newObservations.push({
            type: obs.type || 'insight',
            content: obs.content,
            date: now,
            metadata: {
              confidence: obs.confidence || 0.85,
              refreshedAt: now,
              source: 'codebase-analysis-refresh',
              analysisMethod: 'full-pipeline',
              gitCommitsAnalyzed: gitAnalysisResults?.commits?.length || 0,
              vibeSessionsAnalyzed: vibeAnalysisResults?.sessions?.length || 0
            }
          });
        }
        log(`Generated ${newObservations.length} observations from full codebase analysis (filtered ${parsedObservations.length - filteredObservations.length} insight doc refs)`, 'info');
      } else {
        // Fallback: Generate observations directly from codebase scan
        log('LLM parsing failed, generating from codebase scan directly', 'warning');
        newObservations.push(...this.generateObservationsFromCodebaseScan(
          entityName,
          codebaseState,
          staleObservations.length
        ));
      }

      return newObservations;

    } catch (error) {
      log('Full analysis failed, using codebase scan fallback', 'error', error);

      // Fallback: Generate observations from basic codebase scan
      const codebaseState = await this.scanCodebaseForEntityReferences(entityName, [entityName]);
      return this.generateObservationsFromCodebaseScan(entityName, codebaseState, staleObservations.length);
    }
  }

  /**
   * Extract search terms from entity name and observations for targeted analysis
   */
  private extractSearchTerms(entityName: string, entity: any, observations: string[]): string[] {
    const terms = new Set<string>();

    // Add entity name parts
    entityName.split(/(?=[A-Z])/).forEach(part => {
      if (part.length > 2) terms.add(part.toLowerCase());
    });
    terms.add(entityName.toLowerCase());

    // Add entity tags
    if (entity.tags) {
      entity.tags.forEach((tag: string) => terms.add(tag.toLowerCase()));
    }

    // Extract key terms from observations
    const keyTermPattern = /\b(GraphDB|LevelDB|Graphology|persistence|knowledge|entity|vkb|ukb|MCP|semantic|analysis|insight|pattern)\b/gi;
    observations.forEach(obs => {
      const matches = obs.match(keyTermPattern);
      if (matches) {
        matches.forEach(m => terms.add(m.toLowerCase()));
      }
    });

    return Array.from(terms).slice(0, 10); // Limit to top 10 terms
  }

  /**
   * Scan the codebase to verify what actually exists
   */
  private async scanCodebaseForEntityReferences(
    entityName: string,
    searchTerms: string[]
  ): Promise<{
    existingFiles: string[];
    existingCommands: string[];
    existingComponents: string[];
    relatedCodeSnippets: string[];
  }> {
    const result = {
      existingFiles: [] as string[],
      existingCommands: [] as string[],
      existingComponents: [] as string[],
      relatedCodeSnippets: [] as string[]
    };

    try {
      // NOTE: We do NOT add hardcoded paths here anymore.
      // Entity-specific file discovery should be done by searching for files
      // that actually match the entity name pattern.
      // The existingFiles array is kept empty unless we find truly relevant files.

      // Only add files that match the entity name pattern
      const entityNameLower = entityName.toLowerCase();
      const nameParts = entityName.split(/(?=[A-Z])/).map(p => p.toLowerCase()).filter(p => p.length > 3);

      // Search for files that might be related to this specific entity
      const searchDirs = ['src', 'lib', 'integrations'];
      for (const dir of searchDirs) {
        const dirPath = path.join(this.repositoryPath, dir);
        if (fs.existsSync(dirPath)) {
          try {
            // Only do shallow search for performance
            const files = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const file of files) {
              const fileLower = file.name.toLowerCase();
              // Only add if file name contains significant entity name parts
              if (nameParts.some(p => fileLower.includes(p))) {
                result.existingFiles.push(path.join(dir, file.name));
              }
            }
          } catch {
            // Ignore directory read errors
          }
        }
      }

      // Check for known command scripts
      const commandPaths = [
        { cmd: 'vkb', path: 'bin/vkb' },
        { cmd: 'coding', path: 'bin/coding' }
      ];

      for (const { cmd, path: cmdPath } of commandPaths) {
        const fullPath = path.join(this.repositoryPath, cmdPath);
        if (fs.existsSync(fullPath)) {
          result.existingCommands.push(cmd);
        }
      }

      // Phase 42.2 Plan 04 — legacy persistence trio retired; the components
      // listed here are checked against the live tree, so the entries point
      // at the km-core adapter (Phase 42-01) and the canonical km-core store
      // surface that now replaces the trio.
      const componentPaths = [
        { name: 'KmCoreAdapter', path: 'integrations/semantic-analysis/src/storage/km-core-adapter.ts' },
        { name: 'LegacyConsumerHelpers', path: 'integrations/semantic-analysis/src/storage/legacy-consumer-helpers.ts' },
        { name: 'GraphKMStore', path: 'lib/km-core/src/store/GraphKMStore.ts' },
        { name: 'VkbApiClient', path: 'lib/ukb-unified/core/VkbApiClient.js' }
      ];

      for (const { name, path: compPath } of componentPaths) {
        const fullPath = path.join(this.repositoryPath, compPath);
        if (fs.existsSync(fullPath)) {
          result.existingComponents.push(name);
        }
      }

      // NOTE: Generic codebase facts (shared-memory removal, GraphDB location, etc.)
      // should NOT be added here as they get applied to ALL entities.
      // Entity-specific observations are generated in generateObservationsFromCodebaseScan()
      // for entities whose names match knowledge/persistence patterns.

    } catch (error) {
      log('Codebase scan encountered errors', 'warning', error);
    }

    return result;
  }

  /**
   * Build analysis context from all gathered data
   */
  private buildAnalysisContext(
    entityName: string,
    entity: any,
    staleObservations: string[],
    validationReport: EntityValidationReport,
    gitAnalysis: any,
    vibeAnalysis: any,
    codebaseState: any
  ): {
    codebaseFacts: string;
    gitContext: string;
    vibeContext: string;
    issuesSummary: string;
  } {
    // Format codebase facts
    const codebaseFacts = [
      '### Existing Files/Directories:',
      ...codebaseState.existingFiles.map((f: string) => `- ${f}`),
      '',
      '### Available Commands:',
      ...codebaseState.existingCommands.map((c: string) => `- ${c}`),
      '',
      '### Existing Components:',
      ...codebaseState.existingComponents.map((c: string) => `- ${c}`),
      '',
      '### Key Facts:',
      ...codebaseState.relatedCodeSnippets.map((s: string) => `- ${s}`)
    ].join('\n');

    // Format git context
    let gitContext = '';
    if (gitAnalysis?.commits?.length > 0) {
      const recentCommits = gitAnalysis.commits.slice(0, 5);
      gitContext = recentCommits.map((c: any) =>
        `- ${c.message?.substring(0, 100) || 'No message'} (${c.date || 'unknown date'})`
      ).join('\n');
    }

    // Format vibe context
    let vibeContext = '';
    if (vibeAnalysis?.sessions?.length > 0) {
      vibeContext = vibeAnalysis.sessions.slice(0, 3).map((s: any) =>
        `- Session on ${s.date || 'unknown'}: ${s.summary || s.topics?.join(', ') || 'No summary'}`
      ).join('\n');
    }

    // Format issues summary
    const issuesSummary = validationReport.observationValidations
      .filter(v => !v.isValid)
      .map(v => {
        const issues = v.issues.map(i => `  - ${i.category}: ${i.message}`).join('\n');
        return `Observation: "${v.observation.substring(0, 80)}..."\n${issues}`;
      })
      .join('\n\n');

    return { codebaseFacts, gitContext, vibeContext, issuesSummary };
  }

  /**
   * Build analysis context specifically for insight document generation.
   * This provides the data structure expected by InsightGenerationAgent.
   *
   * IMPORTANT: entity_info.observations is the PRIMARY source of content for insight documents.
   */
  private async buildInsightAnalysisContext(
    entityName: string,
    entity: any,
    newObservations: Array<{ type: string; content: string; date: string; metadata: Record<string, any> }>
  ): Promise<{
    git_analysis: any;
    vibe_analysis: any;
    patterns: any[];
    entity_info: any;
    relations: Array<{ from: string; to: string; relationType: string }>;
  }> {
    // PROTECTED INFRASTRUCTURE ENTITIES: Enforce correct types for insight documents
    // These entities have fixed types that determine visualization colors and semantic meaning
    const PROTECTED_ENTITY_TYPES: Record<string, string> = {
      'Coding': 'Project',
      'CollectiveKnowledge': 'System',
    };

    // Use protected type if available, otherwise fall back to entity's type
    // Default to 'Unclassified' instead of 'Pattern' - let ontology classify properly
    const entityType = PROTECTED_ENTITY_TYPES[entityName] || entity.entityType || entity.type || 'Unclassified';

    const context: {
      git_analysis: any;
      vibe_analysis: any;
      patterns: any[];
      entity_info: any;
      relations: Array<{ from: string; to: string; relationType: string }>;
    } = {
      git_analysis: null,
      vibe_analysis: null,
      patterns: [],
      entity_info: {
        name: entityName,
        type: entityType,
        observations: newObservations.map(o => o.content)
      },
      relations: [] // Will be populated if graph database provides them
    };

    log(`Building insight context for ${entityName} with ${newObservations.length} observations`, 'info');

    try {
      // Get git history for context if available (used as fallback)
      if (this.gitHistoryAgent) {
        const gitResult = await this.gitHistoryAgent.analyzeGitHistory({
          sinceDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
          incremental: false
        });
        context.git_analysis = gitResult;
      }

      // Get vibe/session history if available (used as fallback)
      if (this.vibeHistoryAgent) {
        const vibeResult = await this.vibeHistoryAgent.analyzeVibeHistory({
          sinceDate: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
          incremental: false
        });
        context.vibe_analysis = vibeResult;
      }

      // Extract patterns from entity observations
      context.patterns = newObservations
        .filter(o => o.type === 'pattern' || o.content.toLowerCase().includes('pattern'))
        .map(o => ({
          name: entityName,
          description: o.content,
          type: o.type,
          significance: 7
        }));

      // If no patterns found, create context entry from entity info
      // Don't create generic "Pattern" entries - let ontology classify properly
      if (context.patterns.length === 0 && entity.entityType && entity.entityType !== 'Unclassified') {
        context.patterns.push({
          name: entityName,
          description: `${entity.entityType} - ${entityName}: ${newObservations.slice(0, 3).map(o => o.content).join('. ')}`,
          type: entity.entityType,
          significance: 6
        });
      }

    } catch (error) {
      log('Error building insight analysis context', 'warning', error);
    }

    return context;
  }

  /**
   * Generate observations directly from codebase scan when LLM fails
   */
  private generateObservationsFromCodebaseScan(
    entityName: string,
    codebaseState: any,
    count: number
  ): Array<{ type: string; content: string; date: string; metadata: Record<string, any> }> {
    const now = new Date().toISOString();
    const observations: Array<{ type: string; content: string; date: string; metadata: Record<string, any> }> = [];
    const lowerName = entityName.toLowerCase();

    // Extract entity name parts for pattern matching
    const nameParts = entityName.split(/(?=[A-Z])/).map(p => p.toLowerCase());

    // Only add "implemented across" observation if files are actually relevant to entity name
    if (codebaseState.existingFiles && codebaseState.existingFiles.length > 0) {
      // Filter files that contain entity name parts (case-insensitive)
      const relevantFiles = codebaseState.existingFiles
        .filter((f: string) => {
          const lowerFile = f.toLowerCase();
          return nameParts.some(p => p.length > 3 && lowerFile.includes(p));
        })
        .slice(0, 3);
      // Only add observation if we found actually relevant files
      if (relevantFiles.length > 0) {
        observations.push({
          type: 'implementation',
          content: `${entityName} is implemented across: ${relevantFiles.join(', ')}`,
          date: now,
          metadata: { confidence: 0.9, source: 'codebase-scan', refreshedAt: now }
        });
      }
    }

    // GENERIC: Generate observations from related components
    if (codebaseState.existingComponents && codebaseState.existingComponents.length > 0) {
      const relevantComponents = codebaseState.existingComponents
        .filter((c: string) => nameParts.some(p => c.toLowerCase().includes(p)))
        .slice(0, 3);
      if (relevantComponents.length > 0) {
        observations.push({
          type: 'architecture',
          content: `Core components: ${relevantComponents.join(', ')}`,
          date: now,
          metadata: { confidence: 0.9, source: 'codebase-scan', refreshedAt: now }
        });
      }
    }

    // Generate observations from code snippets (only if entity-relevant)
    if (codebaseState.relatedCodeSnippets && codebaseState.relatedCodeSnippets.length > 0) {
      // Skip generic codebase-level snippets that aren't entity-specific
      const genericPatterns = [
        'shared-memory.json',
        'has been REMOVED',
        'Graphology + LevelDB',
        '.data/knowledge-graph',
        '.data/knowledge-export',
        'auto-synced from GraphDB'
      ];

      for (const snippet of codebaseState.relatedCodeSnippets.slice(0, 3)) {
        // Skip very short, placeholder, or generic snippets
        const isGeneric = genericPatterns.some(p => snippet.includes(p));
        if (snippet.length > 30 && !snippet.includes('observations refreshed') && !isGeneric) {
          // Also check if snippet mentions the entity
          const isRelevant = nameParts.some(p => p.length > 3 && snippet.toLowerCase().includes(p));
          if (isRelevant) {
            const content = snippet.length > 200 ? snippet.substring(0, 200) + '...' : snippet;
            observations.push({
              type: 'insight',
              content: content,
              date: now,
              metadata: { confidence: 0.85, source: 'codebase-scan', refreshedAt: now }
            });
          }
        }
      }
    }

    // SPECIFIC: Knowledge/Persistence entities
    // Phase 42.2 Plan 04 — refers to the post-trio-retirement component
    // names. The legacy GraphDatabaseService / GraphKnowledgeExporter
    // observations were removed because those components are no longer
    // part of the runtime persistence path.
    if (lowerName.includes('persistence') || lowerName.includes('knowledge')) {
      if (codebaseState.existingComponents?.includes('KmCoreAdapter')) {
        observations.push({
          type: 'implementation',
          content: `Knowledge persistence routes through KmCoreAdapter (Phase 42-01 strangler) backed by @fwornle/km-core GraphKMStore (LevelDB + JSON exports)`,
          date: now,
          metadata: { confidence: 0.95, source: 'codebase-scan', refreshedAt: now }
        });
      }
      if (codebaseState.existingComponents?.includes('GraphKMStore')) {
        observations.push({
          type: 'workflow',
          content: `GraphKMStore (km-core) exports the canonical entity snapshot to the data root's kb/knowledge-graph/exports on debounce, resolved through lib/paths rather than hardcoded under the repo`,
          date: now,
          metadata: { confidence: 0.95, source: 'codebase-scan', refreshedAt: now }
        });
      }
    }

    // SPECIFIC: Semantic Analysis entities
    if (lowerName.includes('semantic') || lowerName.includes('analysis')) {
      observations.push({
        type: 'architecture',
        content: `Uses multi-agent architecture: GitHistoryAgent, VibeHistoryAgent, ObservationGenerationAgent, InsightGenerationAgent, ContentValidationAgent, QualityAssuranceAgent`,
        date: now,
        metadata: { confidence: 0.9, source: 'codebase-scan', refreshedAt: now }
      });
      observations.push({
        type: 'workflow',
        content: `Orchestrated by Coordinator agent which manages agent lifecycle, parallel execution, and result aggregation`,
        date: now,
        metadata: { confidence: 0.9, source: 'codebase-scan', refreshedAt: now }
      });
    }

    // SPECIFIC: Workflow entities
    if (lowerName.includes('workflow')) {
      observations.push({
        type: 'implementation',
        content: `Workflow is triggered via MCP tools (execute_workflow) or automatic incremental analysis`,
        date: now,
        metadata: { confidence: 0.85, source: 'codebase-scan', refreshedAt: now }
      });
    }

    // SPECIFIC: Pattern entities
    if (lowerName.includes('pattern')) {
      observations.push({
        type: 'architecture',
        content: `Pattern extracted from codebase analysis and stored as reusable knowledge entity`,
        date: now,
        metadata: { confidence: 0.85, source: 'codebase-scan', refreshedAt: now }
      });
    }

    // SPECIFIC: CLI entities (vkb, ukb)
    if (lowerName.includes('cli') || lowerName.includes('vkb') || lowerName.includes('ukb')) {
      if (codebaseState.existingCommands?.includes('vkb')) {
        observations.push({
          type: 'rule',
          content: `Use 'vkb' command for visualization (http://localhost:8080) and MCP semantic-analysis tools for programmatic access`,
          date: now,
          metadata: { confidence: 0.95, source: 'codebase-scan', refreshedAt: now }
        });
      }
    }

    // SPECIFIC: Configuration entities
    if (lowerName.includes('config')) {
      observations.push({
        type: 'implementation',
        content: `Configuration managed through environment variables and project-level config files`,
        date: now,
        metadata: { confidence: 0.85, source: 'codebase-scan', refreshedAt: now }
      });
    }

    // If still not enough, add generic but meaningful observations
    if (observations.length < count) {
      observations.push({
        type: 'insight',
        content: `${entityName} is part of the semantic analysis and knowledge management infrastructure`,
        date: now,
        metadata: { confidence: 0.75, source: 'codebase-scan-generic', refreshedAt: now }
      });
    }

    // Deduplicate observations by content
    const seen = new Set<string>();
    const uniqueObservations = observations.filter(obs => {
      if (seen.has(obs.content)) return false;
      seen.add(obs.content);
      return true;
    });

    // Pad with entity-specific placeholder if absolutely needed (avoid generic placeholder)
    while (uniqueObservations.length < count) {
      const typeOptions = ['architecture', 'implementation', 'workflow', 'insight'];
      const typeIndex = uniqueObservations.length % typeOptions.length;
      uniqueObservations.push({
        type: typeOptions[typeIndex],
        content: `${entityName} ${typeOptions[typeIndex]} details pending full codebase analysis`,
        date: now,
        metadata: { confidence: 0.6, source: 'codebase-scan-placeholder', refreshedAt: now }
      });
    }

    return uniqueObservations.slice(0, count);
  }

  /**
   * Refresh all stale entities in a team or globally
   *
   * This method:
   * 1. Validates all entities in scope
   * 2. Identifies entities with score < 100 (per design decision), or ALL entities if forceFullRefresh
   * 3. Optionally shows a preview (dryRun mode)
   * 4. Refreshes entities using parallel worker pool (configurable concurrency)
   */
  async refreshAllStaleEntities(params: {
    team?: string;           // Optional: specific team, or all teams if not provided
    scoreThreshold?: number; // Default: 100 (any issue triggers refresh per design decision)
    dryRun?: boolean;        // Preview mode - don't make changes
    maxEntities?: number;    // Limit for safety (default: 50)
    forceFullRefresh?: boolean; // Force regeneration of all diagrams and insights
    parallelWorkers?: number; // Override parallel workers for this batch (default: uses config value)
  }): Promise<{
    dryRun: boolean;
    entitiesScanned: number;
    entitiesNeedingRefresh: number;
    entitiesRefreshed: number;
    entitiesFailed: number;
    results: EntityRefreshResult[];
    summary: string;
    confirmationRequired?: {
      entitiesAffected: Array<{ name: string; currentScore: number; issues: number }>;
      message: string;
    };
  }> {
    const scoreThreshold = params.scoreThreshold ?? 100;
    const maxEntities = params.maxEntities ?? 50;
    const dryRun = params.dryRun ?? false;
    const forceFullRefresh = params.forceFullRefresh ?? false;
    // Use param override or fall back to instance config
    const workerCount = Math.min(Math.max(params.parallelWorkers ?? this.parallelWorkers, 1), 20);

    log(`Starting batch entity refresh`, 'info', {
      team: params.team || 'all',
      scoreThreshold,
      dryRun,
      maxEntities,
      forceFullRefresh,
      parallelWorkers: workerCount
    });

    const batchResult = {
      dryRun,
      entitiesScanned: 0,
      entitiesNeedingRefresh: 0,
      entitiesRefreshed: 0,
      entitiesFailed: 0,
      results: [] as EntityRefreshResult[],
      summary: '',
      confirmationRequired: undefined as {
        entitiesAffected: Array<{ name: string; currentScore: number; issues: number }>;
        message: string;
      } | undefined
    };

    try {
      // Step 1: Get all entities from the graph database
      if (!this.graphDB) {
        batchResult.summary = 'GraphDB not set. Call setGraphDB() first.';
        log(batchResult.summary, 'error');
        return batchResult;
      }

      let entities: any[] = [];
      try {
        // Query all entities, optionally filtered by team
        const queryParams = params.team
          ? { namePattern: '.*', team: params.team }
          : { namePattern: '.*' };

        entities = await this.graphDB.queryEntities(queryParams);
      } catch (error) {
        // Fallback: try loading from shared memory export
        log('GraphDB query failed, trying shared memory fallback', 'warning', error);
        const entity = await this.loadEntity('*', params.team || 'coding');
        if (entity) {
          entities = [entity];
        }
      }

      batchResult.entitiesScanned = entities.length;
      log(`Found ${entities.length} entities to scan`, 'info');

      // Step 2: Validate each entity and collect stale ones
      const staleEntities: Array<{
        entity: any;
        validationReport: EntityValidationReport;
      }> = [];

      for (const entity of entities) {
        // Handle different field names from legacy storage (entity_name) vs normalized (name)
        const entityName = entity.name || entity.entityName || entity.entity_name;
        const entityTeam = entity.team || params.team || 'coding';

        if (!entityName) {
          log(`Entity missing name field, skipping`, 'warning', { entity: JSON.stringify(entity).substring(0, 200) });
          continue;
        }

        try {
          const report = await this.validateEntityAccuracy(entityName, entityTeam);

          // When forceFullRefresh is true, include ALL entities regardless of score
          // Otherwise, only include entities below the score threshold
          if (forceFullRefresh || report.overallScore < scoreThreshold) {
            staleEntities.push({ entity, validationReport: report });

            if (staleEntities.length >= maxEntities) {
              log(`Reached max entities limit (${maxEntities})`, 'warning');
              break;
            }
          }
        } catch (error) {
          log(`Failed to validate entity ${entityName}`, 'warning', error);
        }
      }

      batchResult.entitiesNeedingRefresh = staleEntities.length;
      log(`Found ${staleEntities.length} stale entities`, 'info');

      // Step 3: In dryRun mode, return confirmation required
      if (dryRun || staleEntities.length > 0) {
        batchResult.confirmationRequired = {
          entitiesAffected: staleEntities.map(({ entity, validationReport }) => ({
            name: entity.name || entity.entityName || entity.entity_name,
            currentScore: validationReport.overallScore,
            issues: validationReport.totalIssues
          })),
          message: `Found ${staleEntities.length} entities with validation score below ${scoreThreshold}. ${dryRun ? 'This is a dry run - no changes will be made.' : 'Proceed with refresh?'}`
        };

        if (dryRun) {
          batchResult.summary = `Dry run complete. ${staleEntities.length} entities would be refreshed out of ${entities.length} scanned.`;
          return batchResult;
        }
      }

      // Step 4: Refresh entities using parallel worker pool
      // Each entity refresh is independent, so we can process them concurrently
      log(`Refreshing ${staleEntities.length} entities with ${workerCount} parallel workers`, 'info');

      // Helper function to process a single entity
      const processEntity = async (item: { entity: any; validationReport: EntityValidationReport }): Promise<EntityRefreshResult> => {
        const { entity, validationReport } = item;
        const entityName = entity.name || entity.entityName || entity.entity_name;
        const entityTeam = entity.team || params.team || 'coding';

        try {
          const refreshResult = await this.refreshStaleEntity({
            entityName,
            team: entityTeam,
            validationReport,
            forceFullRefresh
          });
          return refreshResult;
        } catch (error) {
          log(`Failed to refresh entity ${entityName}`, 'error', error);
          return {
            entityName,
            team: entityTeam,
            refreshedAt: new Date().toISOString(),
            validationBefore: validationReport,
            observationChanges: { removed: [], added: [], unchanged: 0 },
            diagramsRegenerated: [],
            insightRefreshed: false,
            success: false,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      };

      // Process entities in batches using a worker pool pattern
      const results: EntityRefreshResult[] = [];

      if (workerCount === 1) {
        // Sequential processing (original behavior)
        for (const item of staleEntities) {
          results.push(await processEntity(item));
        }
      } else {
        // Parallel processing with limited concurrency
        // Process in chunks of workerCount size
        for (let i = 0; i < staleEntities.length; i += workerCount) {
          const chunk = staleEntities.slice(i, i + workerCount);
          const chunkNumber = Math.floor(i / workerCount) + 1;
          const totalChunks = Math.ceil(staleEntities.length / workerCount);

          log(`Processing batch ${chunkNumber}/${totalChunks} (${chunk.length} entities in parallel)`, 'info');

          const chunkResults = await Promise.all(chunk.map(processEntity));
          results.push(...chunkResults);
        }
      }

      // Aggregate results
      batchResult.results = results;
      for (const result of results) {
        if (result.success) {
          batchResult.entitiesRefreshed++;
        } else {
          batchResult.entitiesFailed++;
        }
      }

      // Step 5: Generate summary
      const avgScoreBefore = staleEntities.length > 0
        ? Math.round(staleEntities.reduce((sum, e) => sum + e.validationReport.overallScore, 0) / staleEntities.length)
        : 100;

      const successfulRefreshes = batchResult.results.filter(r => r.success && r.validationAfter);
      const avgScoreAfter = successfulRefreshes.length > 0
        ? Math.round(successfulRefreshes.reduce((sum, r) => sum + (r.validationAfter?.overallScore || 0), 0) / successfulRefreshes.length)
        : avgScoreBefore;

      batchResult.summary = `Batch refresh complete. Scanned: ${batchResult.entitiesScanned}, Needed refresh: ${batchResult.entitiesNeedingRefresh}, Refreshed: ${batchResult.entitiesRefreshed}, Failed: ${batchResult.entitiesFailed}. Average score: ${avgScoreBefore} → ${avgScoreAfter}`;

      log(batchResult.summary, 'info');
      return batchResult;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      batchResult.summary = `Batch refresh failed: ${errorMessage}`;
      log(batchResult.summary, 'error', error);
      return batchResult;
    }
  }
}

// Export default instance factory
export function createContentValidationAgent(
  config?: Partial<ContentValidationAgentConfig>
): ContentValidationAgent {
  return new ContentValidationAgent(config);
}
