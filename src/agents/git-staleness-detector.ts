/**
 * GitStalenessDetector
 *
 * Detects stale entities by correlating git commits to entity content.
 * Uses a three-tier matching strategy:
 *   TIER 1: Fast file-path matching (free, ~1ms)
 *   TIER 2: Hybrid keyword + embedding matching (cached)
 *   TIER 3: LLM correlation via the proxy daemon (batched, model picked by its route)
 *
 * Inspired by Graphiti's bi-temporal model for tracking knowledge freshness.
 */

import * as path from "path";
import * as crypto from "crypto";
import OpenAI from "openai";
import { log } from "../logging.js";
import { createLLMWithProcess } from './llm-with-process.js';
import type { GitCommit, GitFileChange } from "./git-history-agent.js";
import { EmbeddingCache, getSharedEmbeddingCache } from "../utils/embedding-cache.js";
import { isMockLLMEnabled, getMockDelay } from "../mock/llm-mock-service.js";

// ============================================================================
// Interfaces
// ============================================================================

export interface GraphEntity {
  name: string;
  entityType?: string;
  observations?: (string | { type?: string; content?: string })[];
  metadata?: {
    created_at?: string;
    last_updated?: string;
    validated_file_path?: string;
    source?: string;
    [key: string]: any;
  };
}

export interface CommitEntityCorrelation {
  entityName: string;
  commitHash: string;
  commitDate: Date;
  commitMessage: string;
  relevanceScore: number; // 0.0 - 1.0
  matchMethod: "file-path" | "topic-match" | "embedding" | "llm-correlation" | "no-match";
  matchDetails: string;
  entityLastUpdated: Date;
  isStale: boolean;
}

export interface EntityTopics {
  filePaths: string[];
  commands: string[];
  components: string[];
  keywords: string[];
}

export interface CommitTopics {
  filePaths: string[];
  keywords: string[];
  components: string[];
}

export interface StalenessConfig {
  filePathMatchThreshold: number;      // Default: 0.8
  topicMatchThreshold: number;         // Default: 0.6
  llmCorrelationThreshold: number;     // Default: 0.7
  keywordScoreThreshold: number;       // Default: 0.4 - triggers embedding
  skipLlmIfHighConfidence: boolean;    // Default: true
  maxEntitiesPerLlmBatch: number;      // Default: 5
  embeddingCacheTtlMs: number;         // Default: 7 days
}

// ============================================================================
// GitStalenessDetector Class
// ============================================================================

export class GitStalenessDetector {
  private config: StalenessConfig;
  /** TIER 3 correlation calls the proxy daemon as `wave-analysis-staleness`. */
  private llm = createLLMWithProcess('wave-analysis-staleness');
  private openaiClient: OpenAI | null = null;  // For embeddings (TIER 2), via the proxy's /v1/embeddings
  private embeddingCache: EmbeddingCache;

  // Patterns for extracting references from observations
  private filePathPattern = /(?:^|[^\/\w])([\/\w-]+\.(?:ts|js|py|tsx|jsx|json|md|yaml|yml))/gi;
  private commandPattern = /`([a-z][a-z0-9-]*(?:\s[^`]+)?)`/gi;
  private componentPattern = /\b([A-Z][a-zA-Z0-9]*(?:Agent|Service|Manager|Handler|Provider|Adapter))\b/g;

  constructor(config?: Partial<StalenessConfig>) {
    this.config = {
      filePathMatchThreshold: 0.8,
      topicMatchThreshold: 0.6,
      llmCorrelationThreshold: 0.7,
      keywordScoreThreshold: 0.4,
      skipLlmIfHighConfidence: true,
      maxEntitiesPerLlmBatch: 5,
      embeddingCacheTtlMs: 7 * 24 * 60 * 60 * 1000, // 7 days
      ...config,
    };

    // Use shared disk-backed embedding cache
    this.embeddingCache = getSharedEmbeddingCache();
    this.initializeClients();
  }

  private initializeClients(): void {
    // Initialize OpenAI for embeddings (TIER 2) - a direct client, since
    // `/api/complete` does not generate embeddings.
    // T2 egress lockdown: inside the container there is no raw OPENAI_API_KEY;
    // embeddings route through the host proxy's /v1/embeddings passthrough.
    const proxyUrl = process.env.LLM_CLI_PROXY_URL;
    const openaiKey = process.env.OPENAI_API_KEY;
    if (proxyUrl) {
      this.openaiClient = new OpenAI({
        apiKey: openaiKey || "proxy-routed",
        baseURL: `${proxyUrl.replace(/\/$/, "")}/v1`,
        timeout: 30000,
      });
      log("GitStalenessDetector: OpenAI client initialized for embeddings (via llm-cli-proxy)", "info");
    } else if (openaiKey && openaiKey !== "your-openai-api-key") {
      this.openaiClient = new OpenAI({
        apiKey: openaiKey,
        timeout: 30000,
      });
      log("GitStalenessDetector: OpenAI client initialized for embeddings", "info");
    }
  }

  // ============================================================================
  // Main Entry Point
  // ============================================================================

  /**
   * Detect stale entities by correlating git commits to entity content.
   * Returns correlations for entities that have relevant commits after their last update.
   */
  async detectStaleness(
    commits: GitCommit[],
    entities: GraphEntity[]
  ): Promise<CommitEntityCorrelation[]> {
    const startTime = Date.now();
    log(`Starting staleness detection: ${commits.length} commits, ${entities.length} entities`, "info");

    const correlations: CommitEntityCorrelation[] = [];
    const uncertainPairs: Array<{ commit: GitCommit; entity: GraphEntity; currentScore: number }> = [];

    for (const entity of entities) {
      const entityLastUpdated = this.getEntityLastUpdated(entity);

      // Find commits after entity was last updated
      const relevantCommits = commits.filter(c => c.date > entityLastUpdated);
      if (relevantCommits.length === 0) continue;

      for (const commit of relevantCommits) {
        // TIER 1: File-path matching (fast, free)
        const filePathScore = this.matchByFilePath(commit, entity);

        if (filePathScore >= this.config.filePathMatchThreshold) {
          // High confidence file match - entity is stale
          correlations.push({
            entityName: entity.name,
            commitHash: commit.hash,
            commitDate: commit.date,
            commitMessage: commit.message,
            relevanceScore: filePathScore,
            matchMethod: "file-path",
            matchDetails: this.buildFileMatchDetails(commit, entity),
            entityLastUpdated,
            isStale: true,
          });
          continue;
        }

        // TIER 2: Topic-based matching (hybrid: keywords first, embeddings for borderline)
        const topicScore = await this.matchByTopics(commit, entity, filePathScore);

        if (topicScore >= this.config.topicMatchThreshold) {
          correlations.push({
            entityName: entity.name,
            commitHash: commit.hash,
            commitDate: commit.date,
            commitMessage: commit.message,
            relevanceScore: topicScore,
            matchMethod: topicScore > 0.7 ? "embedding" : "topic-match",
            matchDetails: this.buildTopicMatchDetails(commit, entity),
            entityLastUpdated,
            isStale: true,
          });
          continue;
        }

        // Uncertain cases - queue for TIER 3 LLM if score is borderline
        if (topicScore > 0.3 && topicScore < this.config.topicMatchThreshold) {
          uncertainPairs.push({ commit, entity, currentScore: topicScore });
        }
      }
    }

    // TIER 3: LLM correlation for uncertain cases (via the proxy daemon)
    if (uncertainPairs.length > 0) {
      log(`Running TIER 3 LLM correlation for ${uncertainPairs.length} uncertain pairs`, "info");
      const llmResults = await this.matchByLLM(uncertainPairs);

      for (const { commit, entity, currentScore } of uncertainPairs) {
        const key = `${entity.name}:${commit.hash}`;
        const llmScore = llmResults.get(key);

        if (llmScore !== undefined && llmScore >= this.config.llmCorrelationThreshold) {
          const entityLastUpdated = this.getEntityLastUpdated(entity);
          correlations.push({
            entityName: entity.name,
            commitHash: commit.hash,
            commitDate: commit.date,
            commitMessage: commit.message,
            relevanceScore: llmScore,
            matchMethod: "llm-correlation",
            matchDetails: `LLM assessed relevance: ${(llmScore * 100).toFixed(0)}%`,
            entityLastUpdated,
            isStale: true,
          });
        }
      }
    }

    const duration = Date.now() - startTime;
    log(`Staleness detection complete: ${correlations.length} stale correlations found in ${duration}ms`, "info");

    return correlations;
  }

  // ============================================================================
  // TIER 1: File-Path Matching
  // ============================================================================

  private matchByFilePath(commit: GitCommit, entity: GraphEntity): number {
    const entityFilePath = entity.metadata?.validated_file_path;
    const entitySource = entity.metadata?.source;
    const derivedPaths = this.deriveFilePathsFromName(entity.name);

    let maxScore = 0;

    for (const file of commit.files) {
      // Direct match to validated_file_path (highest confidence)
      if (entityFilePath && this.pathContains(file.path, entityFilePath)) {
        return 1.0;
      }

      // Match to source metadata
      if (entitySource && this.pathContains(file.path, entitySource)) {
        maxScore = Math.max(maxScore, 0.9);
        continue;
      }

      // Match to derived paths from entity name
      for (const derived of derivedPaths) {
        if (file.path.toLowerCase().includes(derived.toLowerCase())) {
          maxScore = Math.max(maxScore, 0.8);
          break;
        }
      }

      // Component name in file path (weaker signal)
      const fileName = path.basename(file.path).toLowerCase();
      const entityLower = entity.name.toLowerCase();
      if (fileName.includes(entityLower) || entityLower.includes(fileName.replace(/\.[^.]+$/, ""))) {
        maxScore = Math.max(maxScore, 0.6);
      }
    }

    return maxScore;
  }

  private deriveFilePathsFromName(entityName: string): string[] {
    const paths: string[] = [];

    // PascalCase -> kebab-case
    const kebab = entityName.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    paths.push(`${kebab}.ts`, `${kebab}.js`, `${kebab}.tsx`, `${kebab}.jsx`);

    // Keep original name
    paths.push(`${entityName}.ts`, `${entityName}.js`);

    // Common suffix patterns
    if (entityName.endsWith("Agent")) {
      paths.push(`${kebab.replace("-agent", "")}-agent.ts`);
    }
    if (entityName.endsWith("Service")) {
      paths.push(`${kebab.replace("-service", "")}-service.ts`);
    }
    if (entityName.endsWith("Pattern")) {
      // Patterns often have insight documents
      paths.push(`${entityName}.md`, `${kebab}.md`);
    }

    return paths;
  }

  private pathContains(filePath: string, searchPath: string): boolean {
    const normalizedFile = filePath.toLowerCase().replace(/\\/g, "/");
    const normalizedSearch = searchPath.toLowerCase().replace(/\\/g, "/");
    return normalizedFile.includes(normalizedSearch);
  }

  private buildFileMatchDetails(commit: GitCommit, entity: GraphEntity): string {
    const matchedFiles = commit.files
      .filter(f => {
        const derivedPaths = this.deriveFilePathsFromName(entity.name);
        return derivedPaths.some(d => f.path.toLowerCase().includes(d.toLowerCase()));
      })
      .map(f => f.path)
      .slice(0, 3);

    return `Files matched: ${matchedFiles.join(", ")}`;
  }

  // ============================================================================
  // TIER 2: Topic-Based Matching (Hybrid: Keywords + Embeddings)
  // ============================================================================

  private async matchByTopics(
    commit: GitCommit,
    entity: GraphEntity,
    filePathScore: number
  ): Promise<number> {
    const entityTopics = this.extractEntityTopics(entity);
    const commitTopics = this.extractCommitTopics(commit);

    // Calculate keyword overlap (fast, free)
    const keywordScore = this.calculateKeywordOverlap(entityTopics, commitTopics);

    // If keyword score is confident enough or too low, skip embeddings
    if (keywordScore >= this.config.topicMatchThreshold) {
      return keywordScore;
    }
    if (keywordScore < 0.2) {
      return keywordScore;
    }

    // For borderline cases, use embeddings if available
    if (this.openaiClient && keywordScore >= this.config.keywordScoreThreshold) {
      try {
        const embeddingScore = await this.calculateEmbeddingSimilarity(entity, commit);
        // Weighted average: 40% keyword, 60% embedding
        return keywordScore * 0.4 + embeddingScore * 0.6;
      } catch (error) {
        log("Embedding similarity failed, using keyword score", "warning", error);
        return keywordScore;
      }
    }

    return keywordScore;
  }

  private extractEntityTopics(entity: GraphEntity): EntityTopics {
    const topics: EntityTopics = {
      filePaths: [],
      commands: [],
      components: [],
      keywords: [],
    };

    const allText = this.getEntityObservationsText(entity);

    // Extract file paths
    let match;
    const filePathRegex = new RegExp(this.filePathPattern.source, this.filePathPattern.flags);
    while ((match = filePathRegex.exec(allText)) !== null) {
      topics.filePaths.push(match[1]);
    }

    // Extract commands
    const commandRegex = new RegExp(this.commandPattern.source, this.commandPattern.flags);
    while ((match = commandRegex.exec(allText)) !== null) {
      topics.commands.push(match[1].split(" ")[0]);
    }

    // Extract component names
    const componentRegex = new RegExp(this.componentPattern.source, this.componentPattern.flags);
    while ((match = componentRegex.exec(allText)) !== null) {
      topics.components.push(match[1]);
    }

    // Extract keywords (technical terms)
    topics.keywords = this.extractKeywords(allText);

    return topics;
  }

  private extractCommitTopics(commit: GitCommit): CommitTopics {
    const topics: CommitTopics = {
      filePaths: commit.files.map(f => f.path),
      keywords: this.extractKeywords(commit.message),
      components: [],
    };

    // Extract component names from commit message and file paths
    const allText = commit.message + " " + commit.files.map(f => f.path).join(" ");
    const componentRegex = new RegExp(this.componentPattern.source, this.componentPattern.flags);
    let match;
    while ((match = componentRegex.exec(allText)) !== null) {
      topics.components.push(match[1]);
    }

    return topics;
  }

  private extractKeywords(text: string): string[] {
    // Simple keyword extraction: split by non-word chars, filter noise
    const stopWords = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "could",
      "should", "may", "might", "must", "and", "or", "but", "if", "then",
      "else", "when", "where", "why", "how", "all", "each", "every", "both",
      "few", "more", "most", "other", "some", "such", "no", "not", "only",
      "same", "so", "than", "too", "very", "just", "also", "now", "here",
      "there", "can", "this", "that", "these", "those", "with", "from", "for",
      "into", "during", "before", "after", "above", "below", "to", "of", "in",
      "on", "by", "at", "as", "it", "its", "we", "us", "our", "you", "your",
    ]);

    const words = text.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));

    // Return unique keywords
    return [...new Set(words)];
  }

  private calculateKeywordOverlap(entityTopics: EntityTopics, commitTopics: CommitTopics): number {
    // Combine all entity terms
    const entityTerms = new Set([
      ...entityTopics.keywords,
      ...entityTopics.components.map(c => c.toLowerCase()),
      ...entityTopics.filePaths.map(f => path.basename(f).replace(/\.[^.]+$/, "").toLowerCase()),
    ]);

    // Combine all commit terms
    const commitTerms = new Set([
      ...commitTopics.keywords,
      ...commitTopics.components.map(c => c.toLowerCase()),
      ...commitTopics.filePaths.map(f => path.basename(f).replace(/\.[^.]+$/, "").toLowerCase()),
    ]);

    // Calculate intersection
    const intersection = [...entityTerms].filter(t => commitTerms.has(t));

    if (entityTerms.size === 0 || commitTerms.size === 0) return 0;

    // Use a more lenient scoring approach:
    // - Primary: What fraction of commit's meaningful terms match the entity?
    //   (If commit is about "persistence" and entity mentions "persistence", that's highly relevant)
    // - Secondary: Boost score if multiple key terms match (indicates strong correlation)
    //
    // Rationale: Jaccard is too strict when entity has many terms (denominator grows).
    // We want to detect "does this commit relate to this entity?" which is better
    // measured by commit-term recall against entity terms.

    const commitRecall = intersection.length / commitTerms.size;  // How much of commit relates to entity
    const entityCoverage = intersection.length / entityTerms.size; // How much of entity is touched

    // Weighted combination: prioritize commit recall (70%) with entity coverage boost (30%)
    // This means: if a commit's terms mostly match an entity's domain, it's relevant
    const baseScore = commitRecall * 0.7 + entityCoverage * 0.3;

    // Bonus for having multiple matching terms (reduces false positives from single-word matches)
    const multiMatchBonus = intersection.length >= 3 ? 0.15 : (intersection.length >= 2 ? 0.08 : 0);

    const finalScore = Math.min(1.0, baseScore + multiMatchBonus);

    log(`Keyword overlap: ${intersection.length} matches (${intersection.slice(0, 5).join(', ')}), ` +
        `commitRecall=${commitRecall.toFixed(2)}, entityCoverage=${entityCoverage.toFixed(2)}, ` +
        `score=${finalScore.toFixed(2)}`, 'debug');

    return finalScore;
  }

  private async calculateEmbeddingSimilarity(entity: GraphEntity, commit: GitCommit): Promise<number> {
    if (!this.openaiClient) return 0;

    const entityText = this.getEntityObservationsText(entity);
    const commitText = `${commit.message}\n${commit.files.map(f => f.path).join("\n")}`;

    const entityEmbedding = await this.getEntityEmbedding(entity, entityText);
    const commitEmbedding = await this.generateEmbedding(commitText);

    return this.cosineSimilarity(entityEmbedding, commitEmbedding);
  }

  private async getEntityEmbedding(entity: GraphEntity, text: string): Promise<number[]> {
    const contentHash = EmbeddingCache.hashContent(text);

    // Try to get from disk-backed cache
    const cached = this.embeddingCache.get(entity.name, contentHash);
    if (cached) {
      return cached;
    }

    // Generate new embedding
    const embedding = await this.generateEmbedding(text);

    // Store in disk-backed cache
    this.embeddingCache.set(entity.name, embedding, contentHash, entity.entityType);

    return embedding;
  }

  private async generateEmbedding(text: string): Promise<number[]> {
    if (!this.openaiClient) {
      throw new Error("OpenAI client not initialized");
    }

    // Truncate to avoid token limits
    const truncatedText = text.substring(0, 8000);

    const response = await this.openaiClient.embeddings.create({
      model: "text-embedding-3-small",
      input: truncatedText,
    });

    return response.data[0].embedding;
  }

  private cosineSimilarity(vec1: number[], vec2: number[]): number {
    if (vec1.length !== vec2.length) return 0;

    let dotProduct = 0;
    let magnitude1 = 0;
    let magnitude2 = 0;

    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      magnitude1 += vec1[i] * vec1[i];
      magnitude2 += vec2[i] * vec2[i];
    }

    magnitude1 = Math.sqrt(magnitude1);
    magnitude2 = Math.sqrt(magnitude2);

    if (magnitude1 === 0 || magnitude2 === 0) return 0;
    return dotProduct / (magnitude1 * magnitude2);
  }

  private buildTopicMatchDetails(commit: GitCommit, entity: GraphEntity): string {
    const entityTopics = this.extractEntityTopics(entity);
    const commitTopics = this.extractCommitTopics(commit);

    const matchedKeywords = entityTopics.keywords
      .filter(k => commitTopics.keywords.includes(k))
      .slice(0, 5);

    const matchedComponents = entityTopics.components
      .filter(c => commitTopics.components.includes(c));

    return `Keywords: [${matchedKeywords.join(", ")}], Components: [${matchedComponents.join(", ")}]`;
  }

  // ============================================================================
  // TIER 3: LLM Correlation (via the proxy daemon)
  // ============================================================================

  private async matchByLLM(
    pairs: Array<{ commit: GitCommit; entity: GraphEntity; currentScore: number }>
  ): Promise<Map<string, number>> {
    const results = new Map<string, number>();

    // Check for mock mode BEFORE making any LLM calls
    if (isMockLLMEnabled(process.cwd())) {
      log("LLM Mock mode enabled - returning mock LLM correlation scores", "info");
      const mockDelay = getMockDelay(process.cwd());
      await new Promise(resolve => setTimeout(resolve, mockDelay));

      // Return mock correlation scores (mid-range to indicate uncertain match)
      for (const pair of pairs) {
        const key = `${pair.commit.hash}-${pair.entity.name}`;
        results.set(key, 0.5 + Math.random() * 0.3); // Random score between 0.5-0.8
      }
      return results;
    }

    // Batch pairs for efficiency
    const batches = this.chunkArray(pairs, this.config.maxEntitiesPerLlmBatch);

    for (const batch of batches) {
      try {
        const prompt = this.buildCorrelationPrompt(batch);

        const result = await this.llm.complete({
          messages: [
            {
              role: 'system',
              content: "You are an expert at analyzing code changes and their impact on documentation. Respond only with valid JSON.",
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          taskType: 'staleness_correlation',
          agentId: 'git_staleness_detector',
          maxTokens: 1000,
          temperature: 0.1,
          timeout: 120_000,
        });

        const content = result.content;
        const scores = this.parseLLMResponse(content, batch);

        for (const [key, score] of scores) {
          results.set(key, score);
        }
      } catch (error) {
        log("LLM correlation batch failed", "warning", error);
        // Continue with other batches
      }
    }

    return results;
  }

  private buildCorrelationPrompt(
    batch: Array<{ commit: GitCommit; entity: GraphEntity; currentScore: number }>
  ): string {
    const pairsText = batch
      .map((pair, i) => {
        const obsText = this.getEntityObservationsText(pair.entity).substring(0, 500);
        return `
## Pair ${i + 1}
COMMIT:
- Hash: ${pair.commit.hash}
- Message: ${pair.commit.message}
- Files: ${pair.commit.files.map(f => `${f.path} (${f.status})`).join(", ")}

ENTITY:
- Name: ${pair.entity.name}
- Type: ${pair.entity.entityType || "Unknown"}
- Content: ${obsText}`;
      })
      .join("\n---\n");

    return `Analyze whether these git commits might affect the accuracy of these knowledge entities.

For each pair, rate the relevance from 0.0 (completely unrelated) to 1.0 (directly affects entity accuracy).

${pairsText}

Respond with JSON array:
[{"pair": 1, "score": 0.X, "reason": "brief explanation"}, ...]`;
  }

  private parseLLMResponse(
    content: string,
    batch: Array<{ commit: GitCommit; entity: GraphEntity; currentScore: number }>
  ): Map<string, number> {
    const results = new Map<string, number>();

    try {
      // Extract JSON from response
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return results;

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return results;

      for (const item of parsed) {
        const pairIndex = (item.pair || 0) - 1;
        if (pairIndex >= 0 && pairIndex < batch.length) {
          const pair = batch[pairIndex];
          const key = `${pair.entity.name}:${pair.commit.hash}`;
          results.set(key, Math.min(1, Math.max(0, item.score || 0)));
        }
      }
    } catch (error) {
      log("Failed to parse LLM response", "warning", { content: content.substring(0, 200) });
    }

    return results;
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  private getEntityLastUpdated(entity: GraphEntity): Date {
    const lastUpdated = entity.metadata?.last_updated;
    if (lastUpdated) {
      return new Date(lastUpdated);
    }
    const createdAt = entity.metadata?.created_at;
    if (createdAt) {
      return new Date(createdAt);
    }
    // Default to a very old date to ensure entity is checked
    return new Date(0);
  }

  private getEntityObservationsText(entity: GraphEntity): string {
    const observations = entity.observations || [];
    return observations
      .map(obs => (typeof obs === "string" ? obs : obs.content || ""))
      .join("\n");
  }

  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  // ============================================================================
  // Public Utility Methods
  // ============================================================================

  /**
   * Clear the embedding cache (useful for testing or memory management)
   */
  clearCache(): void {
    this.embeddingCache.clear();
    log("Embedding cache cleared", "info");
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { totalEntries: number; expiredEntries: number; averageAge: number } {
    return this.embeddingCache.getStats();
  }

  /**
   * Initialize the embedding cache (loads from disk)
   */
  async initializeCache(): Promise<void> {
    await this.embeddingCache.initialize();
  }

  /**
   * Flush embedding cache to disk
   */
  async flushCache(): Promise<void> {
    await this.embeddingCache.flush();
  }
}
