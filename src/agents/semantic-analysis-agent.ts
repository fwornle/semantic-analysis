import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logging.js';
import type { IntelligentQueryResult } from './code-graph-agent.js';
import { SemanticAnalyzer } from './semantic-analyzer.js';
import { isMockLLMEnabled, getMockDelay } from '../mock/llm-mock-service.js';
import { LLMService } from '@rapid/llm-proxy';
import type { AnalyzeEntityCodeInput, AnalyzeEntityCodeResult, AnalysisArtifacts, EntityTraceData } from '../types/wave-types.js';
import { attachTokenLogger } from '../utils/token-usage-logger.js';

export interface CodeFile {
  path: string;
  content: string;
  language: string;
  size: number;
  complexity: number;
  patterns: string[];
  functions: string[];
  imports: string[];
  changeType: 'added' | 'modified' | 'deleted';
}

export interface SemanticAnalysisResult {
  codeAnalysis: {
    filesAnalyzed: number;
    totalLinesOfCode: number;
    languageDistribution: Record<string, number>;
    complexityMetrics: {
      averageComplexity: number;
      highComplexityFiles: string[];
      totalFunctions: number;
    };
    architecturalPatterns: {
      name: string;
      files: string[];
      description: string;
      confidence: number;
    }[];
    codeQuality: {
      score: number;
      issues: string[];
      recommendations: string[];
    };
  };
  crossAnalysisInsights: {
    gitCodeCorrelation: string[];
    vibeCodeCorrelation: string[];
    codeGraphCorrelation?: string[];
    conversationImplementationMap: {
      problem: string;
      implementation: string[];
      files: string[];
    }[];
  };
  semanticInsights: {
    keyPatterns: string[];
    architecturalDecisions: string[];
    technicalDebt: string[];
    innovativeApproaches: string[];
    learnings: string[];
  };
  // FIXED: Added insights field for QA compatibility
  insights?: string;
  confidence: number;
  processingTime: number;
}

export class SemanticAnalysisAgent {
  private llmService: LLMService;
  private llmInitialized: boolean = false;
  private repositoryPath: string;

  constructor(repositoryPath: string = '.') {
    this.repositoryPath = repositoryPath;
    this.llmService = new LLMService();
    // Phase 42 Plan 07 — Surprise #5 fix: CommonJS require() → static ESM import.
    attachTokenLogger(this.llmService, 'semantic-analysis-agent');
  }

  private async ensureLLMInitialized(): Promise<void> {
    if (!this.llmInitialized) {
      await this.llmService.initialize();
      this.llmInitialized = true;
      const providers = this.llmService.getAvailableProviders();
      log(`SemanticAnalysisAgent LLMService initialized with providers: ${providers.join(', ')}`, 'info');
    }
  }

  async analyzeGitAndVibeData(
    gitAnalysis: any,
    vibeAnalysis: any,
    options: {
      maxFiles?: number;
      includePatterns?: string[];
      excludePatterns?: string[];
      analysisDepth?: 'surface' | 'deep' | 'comprehensive';
      codeGraphAnalysis?: any;  // AST-parsed code entities from code-graph-rag
      docAnalysis?: any;  // Documentation analysis from documentation-linker agent
    } = {}
  ): Promise<SemanticAnalysisResult> {
    const startTime = Date.now();
    const codeGraph = options.codeGraphAnalysis;
    const docData = options.docAnalysis;

    // ULTRA DEBUG: Write input data to trace file (optional, failures are non-fatal)
    const fs = await import('fs');
    const logsDir = `${process.cwd()}/logs`;
    const traceFile = `${logsDir}/semantic-analysis-trace-${Date.now()}.json`;
    try {
      // Ensure logs directory exists
      await fs.promises.mkdir(logsDir, { recursive: true });
      await fs.promises.writeFile(traceFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        phase: 'INPUT_DATA',
        gitAnalysis: {
          hasData: !!gitAnalysis,
          commitsCount: gitAnalysis?.commits?.length || 0,
          firstCommit: gitAnalysis?.commits?.[0] || null,
          lastCommit: gitAnalysis?.commits?.[gitAnalysis?.commits?.length - 1] || null,
          fullData: gitAnalysis
        },
        vibeAnalysis: {
          hasData: !!vibeAnalysis,
          sessionsCount: vibeAnalysis?.sessions?.length || 0,
          firstSession: vibeAnalysis?.sessions?.[0] || null,
          fullData: vibeAnalysis
        },
        codeGraphAnalysis: {
          hasData: !!codeGraph,
          entitiesCount: codeGraph?.statistics?.totalEntities || 0,
          relationshipsCount: codeGraph?.statistics?.totalRelationships || 0,
          languages: Object.keys(codeGraph?.statistics?.languageDistribution || {}),
          skipped: codeGraph?.skipped || false
        },
        options
      }, null, 2));
      log(`🔍 TRACE: Input data written to ${traceFile}`, 'info');
    } catch (traceError) {
      // Non-fatal: trace file write failure should not abort analysis
      log(`Trace file write failed (non-fatal): ${traceError}`, 'debug');
    }

    log('Starting comprehensive semantic analysis', 'info', {
      gitCommits: gitAnalysis?.commits?.length || 0,
      vibeSessions: vibeAnalysis?.sessions?.length || 0,
      codeGraphEntities: codeGraph?.statistics?.totalEntities || 0,
      codeGraphSkipped: codeGraph?.skipped || false,
      analysisDepth: options.analysisDepth || 'deep',
      traceFile
    });

    try {
      const depth = options.analysisDepth || 'deep';
      let codeFiles: CodeFile[] = [];
      let codeAnalysis: any;
      let crossAnalysisInsights: any;

      if (depth === 'surface') {
        // Surface: analyze up to 5 files for fast but meaningful results
        const filesToAnalyze = this.extractFilesFromGitHistory(gitAnalysis, { ...options, maxFiles: 5 });
        log(`Surface depth: analyzing ${filesToAnalyze.length} files (max 5)`, 'info');
        codeFiles = await this.analyzeCodeFiles(filesToAnalyze, options);
        codeAnalysis = this.generateCodeAnalysisMetrics(codeFiles);
        crossAnalysisInsights = {};  // Skip cross-analysis for speed
      } else {
        // Deep/comprehensive: full file reading and analysis
        const filesToAnalyze = this.extractFilesFromGitHistory(gitAnalysis, options);
        log(`Identified ${filesToAnalyze.length} files for analysis`, 'info');
        codeFiles = await this.analyzeCodeFiles(filesToAnalyze, options);
        codeAnalysis = this.generateCodeAnalysisMetrics(codeFiles);
        crossAnalysisInsights = await this.performCrossAnalysis(
          codeFiles, gitAnalysis, vibeAnalysis, codeGraph
        );
      }

      // Generate semantic insights using LLM (with code graph context)
      const semanticInsights = await this.generateSemanticInsights(
        codeFiles, gitAnalysis, vibeAnalysis, crossAnalysisInsights, codeGraph
      );

      // Enrich architectural patterns with LLM-identified patterns
      // The LLM sees the actual code and identifies real patterns beyond the 10 hardcoded ones
      const llmPatterns = semanticInsights?.keyPatterns || [];
      if (Array.isArray(llmPatterns) && llmPatterns.length > 0) {
        const existingNames = new Set(codeAnalysis.architecturalPatterns.map((p: any) => p.name.toLowerCase()));
        for (const llmPattern of llmPatterns) {
          const patternName = typeof llmPattern === 'string' ? llmPattern : ((llmPattern as any).name || (llmPattern as any).pattern || '');
          const patternDesc = typeof llmPattern === 'string' ? '' : ((llmPattern as any).description || '');
          if (patternName && !existingNames.has(patternName.toLowerCase())) {
            codeAnalysis.architecturalPatterns.push({
              name: patternName,
              files: [],  // LLM doesn't provide file-level mapping
              description: patternDesc || `${patternName} - identified by LLM analysis`,
              confidence: typeof llmPattern === 'object' ? ((llmPattern as any).confidence || 0.7) : 0.7
            });
            existingNames.add(patternName.toLowerCase());
          }
        }
        log(`Enriched architectural patterns: ${codeAnalysis.architecturalPatterns.length} total (${llmPatterns.length} from LLM)`, 'info');
      }

      const processingTime = Date.now() - startTime;
      
      // FIXED: Create aggregated insights for QA validation
      const aggregatedInsights = [
        ...semanticInsights.keyPatterns,
        ...semanticInsights.learnings,
        ...semanticInsights.architecturalDecisions
      ].filter(Boolean).join('. ');
      
      const result: SemanticAnalysisResult = {
        codeAnalysis,
        crossAnalysisInsights,
        semanticInsights,
        insights: aggregatedInsights || 'No specific insights extracted from semantic analysis.',
        confidence: this.calculateConfidence(codeFiles, crossAnalysisInsights),
        processingTime
      };

      log('Semantic analysis completed', 'info', {
        filesAnalyzed: codeFiles.length,
        patternsFound: semanticInsights.keyPatterns.length,
        confidence: result.confidence,
        processingTime,
        hasInsightsField: 'insights' in result,
        insightsLength: result.insights ? result.insights.length : 0
      });

      return result;

    } catch (error) {
      log('Semantic analysis failed', 'error', error);
      throw error;
    }
  }

  // Request timeout for LLM API calls (30 seconds)
  private static readonly LLM_TIMEOUT_MS = 30000;

  private extractFilesFromGitHistory(
    gitAnalysis: any,
    options: { maxFiles?: number; includePatterns?: string[]; excludePatterns?: string[] }
  ): string[] {
    const {
      maxFiles = 100, // Increased from 50 to capture more relevant files
      includePatterns = ['**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx', '**/*.json', '**/*.md'],
      excludePatterns = ['node_modules/**', 'dist/**', '.git/**', '**/*.log', '**/package-lock.json', '**/yarn.lock']
    } = options;

    const filesSet = new Set<string>();

    // DEBUG: Log what we received
    log('File extraction - received gitAnalysis', 'info', {
      hasGitAnalysis: !!gitAnalysis,
      gitAnalysisType: typeof gitAnalysis,
      hasCommits: !!gitAnalysis?.commits,
      commitsLength: gitAnalysis?.commits?.length || 0,
      gitAnalysisKeys: gitAnalysis ? Object.keys(gitAnalysis) : [],
      firstCommitSample: gitAnalysis?.commits?.[0] ? {
        hash: gitAnalysis.commits[0].hash,
        hasFiles: !!gitAnalysis.commits[0].files,
        filesCount: gitAnalysis.commits[0].files?.length || 0
      } : null
    });

    // Extract files from commits
    if (gitAnalysis?.commits) {
      gitAnalysis.commits.forEach((commit: any) => {
        if (commit.files) {
          commit.files.forEach((file: any) => {
            if (this.shouldIncludeFile(file.path, includePatterns, excludePatterns)) {
              filesSet.add(file.path);
            }
          });
        }
      });
    }

    // Extract files from architectural decisions
    if (gitAnalysis?.architecturalDecisions) {
      gitAnalysis.architecturalDecisions.forEach((decision: any) => {
        if (decision.files) {
          decision.files.forEach((filePath: string) => {
            if (this.shouldIncludeFile(filePath, includePatterns, excludePatterns)) {
              filesSet.add(filePath);
            }
          });
        }
      });
    }

    // Convert to array and limit
    const files = Array.from(filesSet).slice(0, maxFiles);
    
    log(`File extraction: ${filesSet.size} unique files found, analyzing top ${files.length}`, 'info');
    return files;
  }

  private shouldIncludeFile(
    filePath: string, 
    includePatterns: string[], 
    excludePatterns: string[]
  ): boolean {
    // Check exclude patterns first
    for (const pattern of excludePatterns) {
      const regex = new RegExp(pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*'));
      if (regex.test(filePath)) {
        return false;
      }
    }

    // Check include patterns
    for (const pattern of includePatterns) {
      const regex = new RegExp(pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*'));
      if (regex.test(filePath)) {
        return true;
      }
    }

    return false;
  }

  private async analyzeCodeFiles(
    filePaths: string[], 
    options: { analysisDepth?: string }
  ): Promise<CodeFile[]> {
    const codeFiles: CodeFile[] = [];
    const depth = options.analysisDepth || 'deep';

    for (const filePath of filePaths) {
      try {
        const fullPath = path.join(this.repositoryPath, filePath);
        
        if (!fs.existsSync(fullPath)) {
          log(`File not found: ${filePath}`, 'warning');
          continue;
        }

        const stats = fs.statSync(fullPath);
        if (stats.size > 1024 * 1024) { // Skip files > 1MB
          log(`Skipping large file: ${filePath} (${stats.size} bytes)`, 'info');
          continue;
        }

        const content = fs.readFileSync(fullPath, 'utf8');
        const language = this.detectLanguage(filePath);

        const codeFile: CodeFile = {
          path: filePath,
          content,
          language,
          size: content.length,
          complexity: this.calculateComplexity(content, language),
          patterns: this.detectCodePatterns(content, language),
          functions: this.extractFunctions(content, language),
          imports: this.extractImports(content, language),
          changeType: 'modified' // Default, could be enhanced with git diff analysis
        };

        codeFiles.push(codeFile);

      } catch (error) {
        log(`Error analyzing file ${filePath}`, 'warning', error);
      }
    }

    log(`Code analysis completed: ${codeFiles.length} files processed`, 'info');
    return codeFiles;
  }

  private detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const languageMap: Record<string, string> = {
      '.ts': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.tsx': 'typescript',
      '.json': 'json',
      '.md': 'markdown',
      '.py': 'python',
      '.java': 'java',
      '.cpp': 'cpp',
      '.c': 'c',
      '.go': 'go',
      '.rs': 'rust',
      '.php': 'php',
      '.rb': 'ruby',
      '.yml': 'yaml',
      '.yaml': 'yaml'
    };

    return languageMap[ext] || 'text';
  }

  private calculateComplexity(content: string, language: string): number {
    // Simple cyclomatic complexity estimation
    let complexity = 1; // Base complexity

    // Count decision points based on language
    const patterns = {
      typescript: /\b(if|else|while|for|switch|case|catch|&&|\|\||\?)\b/g,
      javascript: /\b(if|else|while|for|switch|case|catch|&&|\|\||\?)\b/g,
      python: /\b(if|elif|else|while|for|try|except|and|or)\b/g,
      java: /\b(if|else|while|for|switch|case|catch|&&|\|\||\?)\b/g
    };

    const pattern = patterns[language as keyof typeof patterns] || patterns.javascript;
    const matches = content.match(pattern);
    
    if (matches) {
      complexity += matches.length;
    }

    return Math.min(complexity, 50); // Cap at 50 for sanity
  }

  private detectCodePatterns(content: string, language: string): string[] {
    const patterns: string[] = [];

    // Common architectural patterns
    const patternMatches = [
      { pattern: 'singleton', regex: /class\s+\w+\s*{[\s\S]*?private\s+static\s+instance/i },
      { pattern: 'factory', regex: /create\w*\s*\([^)]*\)[\s\S]*?return\s+new/i },
      { pattern: 'observer', regex: /(addEventListener|subscribe|notify|Observer)/i },
      { pattern: 'promise', regex: /(Promise|async|await)/i },
      { pattern: 'decorator', regex: /@\w+/g },
      { pattern: 'middleware', regex: /(middleware|next\(\)|express)/i },
      { pattern: 'repository', regex: /Repository|DataAccess/i },
      { pattern: 'service', regex: /Service|Provider/i },
      { pattern: 'component', regex: /(React\.|Component|useState|useEffect)/i },
      { pattern: 'api', regex: /(fetch|axios|http|api)/i }
    ];

    for (const { pattern, regex } of patternMatches) {
      if (regex.test(content)) {
        patterns.push(pattern);
      }
    }

    return patterns;
  }

  private extractFunctions(content: string, language: string): string[] {
    const functions: string[] = [];

    // Language-specific function extraction
    let functionRegex: RegExp;

    switch (language) {
      case 'typescript':
      case 'javascript':
        functionRegex = /(?:function\s+(\w+)|(\w+)\s*\([^)]*\)\s*(?:=>|\{)|(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?:=>|\{))/g;
        break;
      case 'python':
        functionRegex = /def\s+(\w+)\s*\(/g;
        break;
      case 'java':
        functionRegex = /(?:public|private|protected)?\s*(?:static)?\s*\w+\s+(\w+)\s*\(/g;
        break;
      default:
        functionRegex = /function\s+(\w+)|(\w+)\s*\(/g;
    }

    let match;
    while ((match = functionRegex.exec(content)) !== null) {
      const functionName = match[1] || match[2] || match[3];
      if (functionName && functionName !== 'if' && functionName !== 'for') {
        functions.push(functionName);
      }
    }

    return [...new Set(functions)]; // Remove duplicates
  }

  private extractImports(content: string, language: string): string[] {
    const imports: string[] = [];

    // Language-specific import extraction
    let importRegex: RegExp;

    switch (language) {
      case 'typescript':
      case 'javascript':
        importRegex = /import\s+(?:.*?\s+from\s+)?['"`]([^'"`]+)['"`]/g;
        break;
      case 'python':
        importRegex = /(?:from\s+(\S+)\s+import|import\s+([^;\n]+))/g;
        break;
      case 'java':
        importRegex = /import\s+([^;\n]+);/g;
        break;
      default:
        importRegex = /import\s+['"`]([^'"`]+)['"`]/g;
    }

    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1] || match[2];
      if (importPath) {
        imports.push(importPath.trim());
      }
    }

    return [...new Set(imports)]; // Remove duplicates
  }

  private generateCodeAnalysisMetrics(codeFiles: CodeFile[]): SemanticAnalysisResult['codeAnalysis'] {
    const totalLinesOfCode = codeFiles.reduce((sum, file) => 
      sum + file.content.split('\n').length, 0
    );

    // Language distribution
    const languageDistribution: Record<string, number> = {};
    codeFiles.forEach(file => {
      languageDistribution[file.language] = (languageDistribution[file.language] || 0) + 1;
    });

    // Complexity metrics
    const complexities = codeFiles.map(f => f.complexity);
    const averageComplexity = complexities.reduce((a, b) => a + b, 0) / complexities.length;
    const highComplexityFiles = codeFiles
      .filter(f => f.complexity > 10)
      .map(f => f.path);
    const totalFunctions = codeFiles.reduce((sum, f) => sum + f.functions.length, 0);

    // Architectural patterns
    const patternCounts = new Map<string, { files: string[]; count: number }>();
    codeFiles.forEach(file => {
      file.patterns.forEach(pattern => {
        if (!patternCounts.has(pattern)) {
          patternCounts.set(pattern, { files: [], count: 0 });
        }
        const data = patternCounts.get(pattern)!;
        data.files.push(file.path);
        data.count++;
      });
    });

    const architecturalPatterns = Array.from(patternCounts.entries())
      .map(([name, data]) => ({
        name,
        files: data.files,
        description: this.getPatternDescription(name),
        confidence: Math.min(data.count / codeFiles.length, 1)
      }))
      .sort((a, b) => b.confidence - a.confidence);

    // Code quality assessment
    const codeQuality = this.assessCodeQuality(codeFiles);

    return {
      filesAnalyzed: codeFiles.length,
      totalLinesOfCode,
      languageDistribution,
      complexityMetrics: {
        averageComplexity: Math.round(averageComplexity * 100) / 100,
        highComplexityFiles,
        totalFunctions
      },
      architecturalPatterns,
      codeQuality
    };
  }

  private getPatternDescription(pattern: string): string {
    const descriptions: Record<string, string> = {
      singleton: 'Ensures a class has only one instance',
      factory: 'Creates objects without specifying exact classes',
      observer: 'Defines one-to-many dependency between objects',
      promise: 'Handles asynchronous operations',
      decorator: 'Adds behavior to objects dynamically',
      middleware: 'Processes requests in a pipeline',
      repository: 'Encapsulates data access logic',
      service: 'Contains business logic',
      component: 'Reusable UI building blocks',
      api: 'Handles external communication'
    };

    return descriptions[pattern] || `${pattern} pattern implementation`;
  }

  private assessCodeQuality(codeFiles: CodeFile[]): { score: number; issues: string[]; recommendations: string[] } {
    const issues: string[] = [];
    const recommendations: string[] = [];
    let score = 100;

    // Check for high complexity
    const highComplexityCount = codeFiles.filter(f => f.complexity > 15).length;
    if (highComplexityCount > 0) {
      issues.push(`${highComplexityCount} files have high complexity (>15)`);
      recommendations.push('Consider refactoring complex functions into smaller ones');
      score -= highComplexityCount * 5;
    }

    // Check for large files
    const largeFiles = codeFiles.filter(f => f.content.split('\n').length > 500);
    if (largeFiles.length > 0) {
      issues.push(`${largeFiles.length} files exceed 500 lines`);
      recommendations.push('Break down large files into smaller, focused modules');
      score -= largeFiles.length * 3;
    }

    // Check for missing patterns
    const hasServices = codeFiles.some(f => f.patterns.includes('service'));
    const hasComponents = codeFiles.some(f => f.patterns.includes('component'));
    if (!hasServices && codeFiles.length > 5) {
      recommendations.push('Consider implementing service layer for better separation of concerns');
    }

    return {
      score: Math.max(0, score),
      issues,
      recommendations
    };
  }

  private async performCrossAnalysis(
    codeFiles: CodeFile[],
    gitAnalysis: any,
    vibeAnalysis: any,
    codeGraph?: any,
    intelligentResults?: IntelligentQueryResult
  ): Promise<SemanticAnalysisResult['crossAnalysisInsights']> {
    const gitCodeCorrelation: string[] = [];
    const vibeCodeCorrelation: string[] = [];
    const codeGraphCorrelation: string[] = [];
    const conversationImplementationMap: any[] = [];

    // Correlate git patterns with code patterns
    if (gitAnalysis?.codeEvolution) {
      gitAnalysis.codeEvolution.forEach((pattern: any) => {
        const relatedFiles = codeFiles.filter(file =>
          pattern.files.some((gitFile: any) => {
            const fileName = typeof gitFile === 'string' ? gitFile : String(gitFile);
            return file.path.includes(fileName);
          })
        );
        if (relatedFiles.length > 0) {
          const codePatterns = [...new Set(relatedFiles.flatMap(f => f.patterns))];
          gitCodeCorrelation.push(
            `Git pattern "${pattern.pattern}" correlates with code patterns: ${codePatterns.join(', ')}`
          );
        }
      });
    }

    // Correlate conversation themes with code implementation
    if (vibeAnalysis?.problemSolutionPairs) {
      vibeAnalysis.problemSolutionPairs.forEach((pair: any) => {
        const implementationFiles = codeFiles.filter(file =>
          pair.solution.technologies.some((tech: string) =>
            file.language.toLowerCase().includes(tech.toLowerCase()) ||
            file.content.toLowerCase().includes(tech.toLowerCase())
          )
        );

        if (implementationFiles.length > 0) {
          conversationImplementationMap.push({
            problem: pair.problem.description.substring(0, 100) + '...',
            implementation: implementationFiles.flatMap(f => f.patterns),
            files: implementationFiles.map(f => f.path)
          });

          vibeCodeCorrelation.push(
            `Problem "${pair.problem.description.substring(0, 50)}..." implemented using ${implementationFiles.map(f => f.language).join(', ')}`
          );
        }
      });
    }

    // Correlate code graph AST entities with git changes
    if (codeGraph && !codeGraph.skipped && codeGraph.statistics) {
      const stats = codeGraph.statistics;

      // Summarize code structure from AST analysis
      if (stats.totalEntities > 0) {
        codeGraphCorrelation.push(
          `Code graph indexed ${stats.totalEntities} entities (functions, classes, methods) with ${stats.totalRelationships || 0} relationships`
        );
      }

      // Language distribution insights
      if (stats.languageDistribution) {
        const langs = Object.entries(stats.languageDistribution)
          .sort((a: any, b: any) => b[1] - a[1])
          .slice(0, 5)
          .map(([lang, count]) => `${lang}: ${count}`)
          .join(', ');
        if (langs) {
          codeGraphCorrelation.push(`Language distribution: ${langs}`);
        }
      }

      // Entity type breakdown
      if (stats.entityTypes) {
        const types = Object.entries(stats.entityTypes)
          .filter(([_, count]) => (count as number) > 0)
          .map(([type, count]) => `${type}: ${count}`)
          .join(', ');
        if (types) {
          codeGraphCorrelation.push(`Entity types: ${types}`);
        }
      }

      // Correlate git-changed files with code graph entities
      if (gitAnalysis?.commits && codeGraph.entities) {
        const changedFiles = new Set<string>();
        gitAnalysis.commits.forEach((commit: any) => {
          commit.files?.forEach((f: any) => changedFiles.add(f.path || f));
        });

        const affectedEntities = (codeGraph.entities || []).filter((entity: any) =>
          [...changedFiles].some(file => entity.file?.includes(file))
        );

        if (affectedEntities.length > 0) {
          codeGraphCorrelation.push(
            `Git changes affected ${affectedEntities.length} code entities (${affectedEntities.slice(0, 5).map((e: any) => e.name).join(', ')}${affectedEntities.length > 5 ? '...' : ''})`
          );
        }
      }
    }

    // Integrate intelligent query results from code graph
    if (intelligentResults) {
      log(`[SemanticAnalysisAgent] Integrating ${intelligentResults.rawQueries.length} intelligent query results`, 'info');

      // Add hotspots as critical correlations
      if (intelligentResults.hotspots.length > 0) {
        const topHotspots = intelligentResults.hotspots
          .sort((a, b) => b.connections - a.connections)
          .slice(0, 5);
        codeGraphCorrelation.push(
          `Critical hotspots (high connectivity): ${topHotspots.map(h => `${h.name} (${h.connections} connections)`).join(', ')}`
        );
      }

      // Add circular dependencies as warnings
      if (intelligentResults.circularDeps.length > 0) {
        codeGraphCorrelation.push(
          `WARNING: ${intelligentResults.circularDeps.length} potential circular dependencies detected: ${intelligentResults.circularDeps.slice(0, 3).map(d => `${d.from} <-> ${d.to}`).join(', ')}${intelligentResults.circularDeps.length > 3 ? '...' : ''}`
        );
      }

      // Add inheritance insights
      if (intelligentResults.inheritanceTree.length > 0) {
        const totalChildren = intelligentResults.inheritanceTree.reduce((sum, i) => sum + i.children.length, 0);
        codeGraphCorrelation.push(
          `Inheritance structure: ${intelligentResults.inheritanceTree.length} base classes with ${totalChildren} derived classes`
        );
      }

      // Add change impact analysis
      if (intelligentResults.changeImpact.length > 0) {
        const totalAffected = intelligentResults.changeImpact.reduce((sum, c) => sum + c.affected.length, 0);
        codeGraphCorrelation.push(
          `Change impact analysis: ${intelligentResults.changeImpact.length} changed entities affecting ${totalAffected} dependents`
        );
      }

      // Add architectural patterns discovered
      if (intelligentResults.architecturalPatterns.length > 0) {
        for (const pattern of intelligentResults.architecturalPatterns.slice(0, 3)) {
          codeGraphCorrelation.push(
            `Architectural pattern: ${pattern.pattern.slice(0, 60)} (${pattern.evidence.length} evidence items)`
          );
        }
      }

      // Add general correlations from queries
      codeGraphCorrelation.push(...intelligentResults.correlations.slice(0, 5));
    }

    return {
      gitCodeCorrelation,
      vibeCodeCorrelation,
      codeGraphCorrelation,
      conversationImplementationMap
    };
  }

  private async generateSemanticInsights(
    codeFiles: CodeFile[],
    gitAnalysis: any,
    vibeAnalysis: any,
    crossAnalysis: any,
    codeGraph?: any
  ): Promise<SemanticAnalysisResult['semanticInsights']> {
    // Ensure LLMService is initialized
    await this.ensureLLMInitialized();

    const providers = this.llmService.getAvailableProviders();
    if (providers.length === 0) {
      throw new Error(
        `SemanticAnalysisAgent: No LLM providers available - cannot generate quality insights.\n\n` +
        `Configure at least one provider via API keys or subscription CLI.\n` +
        `See config/llm-providers.yaml for provider priority configuration.`
      );
    }

    return await this.generateLLMInsights(codeFiles, gitAnalysis, vibeAnalysis, crossAnalysis, codeGraph);
  }

  private async generateLLMInsights(
    codeFiles: CodeFile[],
    gitAnalysis: any,
    vibeAnalysis: any,
    crossAnalysis: any,
    codeGraph?: any
  ): Promise<SemanticAnalysisResult['semanticInsights']> {
    try {
      // Check for mock mode BEFORE making any LLM calls
      if (isMockLLMEnabled(this.repositoryPath)) {
        log('LLM Mock mode enabled - returning mock semantic insights', 'info');
        const mockDelay = getMockDelay(this.repositoryPath);
        await new Promise(resolve => setTimeout(resolve, mockDelay));

        // Return realistic mock insights
        return {
          keyPatterns: [
            'MockPattern: Component-based architecture with React hooks | Example: `useSelector`, `useDispatch` | DO: Use typed selectors | DON\'T: Access store directly',
            'MockPattern: Service layer abstraction | Example: `ApiService.fetch()` | DO: Centralize API calls | DON\'T: Scatter fetch calls'
          ],
          architecturalDecisions: [
            'MockDecision: Redux Toolkit for state management | Rationale: Reduced boilerplate, better TypeScript support',
            'MockDecision: Feature-based folder structure | Rationale: Better code organization and maintainability'
          ],
          technicalDebt: [
            'MockDebt: Legacy callback props in OldComponent | Priority: medium | Fix: Migrate to hooks'
          ],
          innovativeApproaches: [
            'MockApproach: Custom hook composition for complex state logic'
          ],
          learnings: [
            'MockLearning: AsyncThunkErrorHandling | Insight: Use rejectWithValue for typed errors | Example: `createAsyncThunk`'
          ]
        };
      }

      const analysisPrompt = this.buildAnalysisPrompt(codeFiles, gitAnalysis, vibeAnalysis, crossAnalysis, codeGraph);

      // ULTRA DEBUG: Write LLM prompt to trace file
      const fs2 = await import('fs');
      const promptTraceFile = `${process.cwd()}/logs/semantic-analysis-prompt-${Date.now()}.txt`;
      await fs2.promises.writeFile(promptTraceFile, `=== LLM PROMPT ===\n${analysisPrompt}\n\n=== END PROMPT ===\n`);
      log(`🔍 TRACE: LLM prompt written to ${promptTraceFile}`, 'info');

      // Use unified LLM service with automatic provider chain and fallback
      // Explicit tier: 'standard' — the prompt is large (12-17KB) and copilot proxy
      // times out at 120s, so task_provider_priority routes to groq first
      const result = await this.llmService.complete({
        messages: [{ role: 'user', content: analysisPrompt }],
        taskType: 'semantic_code_analysis',
        agentId: 'semantic_analysis',
        tier: 'standard',
        maxTokens: 4096,
        temperature: 0.7,
        timeout: 60_000,  // 60s per provider — fail fast, try next
      });

      const response = result.content;

      // Record LLM metrics for workflow tracking
      SemanticAnalyzer.recordMetricsFromExternal({
        provider: result.provider,
        model: result.model,
        inputTokens: result.tokens.input,
        outputTokens: result.tokens.output,
        totalTokens: result.tokens.total,
      });

      log(`LLM call successful via ${result.provider}/${result.model}`, 'info', {
        responseLength: response.length,
        tokens: result.tokens.total,
        latencyMs: result.latencyMs,
      });

      // ULTRA DEBUG: Write LLM response to trace file
      const fs3 = await import('fs');
      const responseTraceFile = `${process.cwd()}/logs/semantic-analysis-response-${Date.now()}.txt`;
      await fs3.promises.writeFile(responseTraceFile, `=== LLM RESPONSE ===\n${response}\n\n=== END RESPONSE ===\n`);
      log(`🔍 TRACE: LLM response written to ${responseTraceFile}`, 'info');

      const parsedInsights = this.parseInsightsFromLLMResponse(response);

      // ULTRA DEBUG: Write parsed insights to trace file
      const parsedTraceFile = `${process.cwd()}/logs/semantic-analysis-parsed-${Date.now()}.json`;
      await fs3.promises.writeFile(parsedTraceFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        phase: 'PARSED_INSIGHTS',
        parsedInsights
      }, null, 2));
      log(`🔍 TRACE: Parsed insights written to ${parsedTraceFile}`, 'info');

      return parsedInsights;

    } catch (error) {
      log('LLM insight generation failed, falling back to rule-based', 'warning', error);
      return this.generateRuleBasedInsights(codeFiles, gitAnalysis, vibeAnalysis, crossAnalysis);
    }
  }

  private buildAnalysisPrompt(
    codeFiles: CodeFile[],
    gitAnalysis: any,
    vibeAnalysis: any,
    crossAnalysis: any,
    codeGraph?: any
  ): string {
    // Include more files with meaningful content (up to 15)
    const codeOverview = codeFiles.slice(0, 15).map(file => ({
      path: file.path,
      language: file.language,
      patterns: file.patterns,
      functions: file.functions.slice(0, 10),
      complexity: file.complexity
    }));

    // Extract ACTUAL commit messages (most recent 30 significant commits)
    const recentCommits = (gitAnalysis?.commits || [])
      .slice(0, 30)
      .map((c: any) => ({
        message: c.message,
        files: c.files?.map((f: any) => f.path).slice(0, 5),
        changes: c.stats?.totalChanges || 0,
        date: c.date
      }));

    // Extract ACTUAL architectural decisions with details
    const architecturalDecisions = (gitAnalysis?.architecturalDecisions || [])
      .slice(0, 15)
      .map((d: any) => ({
        type: d.type,
        description: d.description,
        impact: d.impact,
        files: d.files?.slice(0, 3)
      }));

    // Extract code evolution patterns with details
    const codeEvolution = (gitAnalysis?.codeEvolution || [])
      .slice(0, 10)
      .map((p: any) => ({
        pattern: p.pattern,
        trend: p.trend,
        occurrences: p.occurrences,
        files: p.files?.slice(0, 3)
      }));

    // Extract ACTUAL problem-solution pairs from VIBE sessions
    const problemSolutions = (vibeAnalysis?.problemSolutionPairs || [])
      .slice(0, 15)
      .map((ps: any) => ({
        problem: ps.problem?.substring(0, 200),
        solution: ps.solution?.substring(0, 200),
        difficulty: ps.difficulty
      }));

    // Extract development themes with context
    const devThemes = (vibeAnalysis?.patterns?.developmentThemes || [])
      .slice(0, 10)
      .map((t: any) => ({
        theme: t.theme,
        frequency: t.frequency,
        examples: t.examples?.slice(0, 2)
      }));

    // Build code graph section if available
    let codeGraphSection = '';
    if (codeGraph && !codeGraph.skipped && codeGraph.statistics) {
      const stats = codeGraph.statistics;
      const entitySummary = {
        totalEntities: stats.totalEntities || 0,
        totalRelationships: stats.totalRelationships || 0,
        languages: stats.languageDistribution || {},
        entityTypes: stats.entityTypes || {}
      };

      // Include top entities if available
      const topEntities = (codeGraph.entities || [])
        .slice(0, 20)
        .map((e: any) => ({
          name: e.name,
          type: e.type,
          file: e.file,
          callers: e.callers?.length || 0,
          callees: e.callees?.length || 0
        }));

      codeGraphSection = `
=== CODE GRAPH (AST Analysis) ===
Summary: ${JSON.stringify(entitySummary, null, 2)}

Top Entities (functions, classes, methods with call relationships):
${JSON.stringify(topEntities, null, 2)}
`;
    }

    // Build cross-analysis section with code graph correlations
    let crossAnalysisSection = '';
    if (crossAnalysis.gitCodeCorrelation?.length || crossAnalysis.vibeCodeCorrelation?.length || crossAnalysis.codeGraphCorrelation?.length) {
      crossAnalysisSection = `=== CROSS-ANALYSIS CORRELATIONS ===
Git-Code Correlations:
${crossAnalysis.gitCodeCorrelation?.join('\n') || 'None'}

Session-Code Correlations:
${crossAnalysis.vibeCodeCorrelation?.join('\n') || 'None'}

Code Graph Correlations:
${crossAnalysis.codeGraphCorrelation?.join('\n') || 'None'}`;
    } else {
      crossAnalysisSection = `=== CROSS-ANALYSIS CORRELATIONS ===
None`;
    }

    return `Analyze this software development project and provide comprehensive insights.

=== CODE ANALYSIS (${codeFiles.length} files analyzed) ===
${JSON.stringify(codeOverview, null, 2)}

=== RECENT COMMIT HISTORY (${gitAnalysis?.commits?.length || 0} total commits) ===
${JSON.stringify(recentCommits, null, 2)}

=== ARCHITECTURAL DECISIONS (${gitAnalysis?.architecturalDecisions?.length || 0} identified) ===
${JSON.stringify(architecturalDecisions, null, 2)}

=== CODE EVOLUTION PATTERNS ===
${JSON.stringify(codeEvolution, null, 2)}
${codeGraphSection}
=== DEVELOPMENT SESSIONS (${vibeAnalysis?.sessions?.length || 0} sessions) ===
Problem-Solution Pairs:
${JSON.stringify(problemSolutions, null, 2)}

Development Themes:
${JSON.stringify(devThemes, null, 2)}

${crossAnalysisSection}

Based on this comprehensive analysis, provide STRUCTURED insights in JSON format.

CRITICAL REQUIREMENTS - Each insight MUST include:
1. A descriptive PascalCase name (e.g., "TypedReduxHooks", "ErrorBoundaryRecovery")
2. Actual code examples with backticks
3. DO rules (ALWAYS, Use X when...)
4. DON'T rules (NEVER, Avoid X when...)
5. Evidence from commits or files

JSON Format:
{
  "patterns": [
    {
      "name": "DescriptivePascalCaseName",
      "problem": "What specific problem this solves",
      "solution": "How it solves the problem",
      "codeExample": "\`const hooks = useTypedSelector(state => state.feature)\`",
      "doRules": ["ALWAYS use typed selectors", "Use memoization for expensive computations"],
      "dontRules": ["NEVER access state directly without selectors", "Avoid inline object creation in selectors"],
      "evidence": ["commit: abc123 - Added typed Redux hooks", "file: src/store/hooks.ts"]
    }
  ],
  "architecturalDecisions": [
    {
      "name": "FeatureSliceArchitecture",
      "decision": "What was decided",
      "rationale": "Why this approach was chosen",
      "codeExample": "\`createSlice({ name: 'feature', initialState, reducers })\`",
      "tradeoffs": ["Pro: Better code organization", "Con: More boilerplate"],
      "evidence": ["commit: def456 - Migrated to feature slices"]
    }
  ],
  "technicalDebt": [
    {
      "name": "LegacyCallbackProps",
      "issue": "What the problem is",
      "location": "src/components/OldComponent.tsx:45-67",
      "suggestedFix": "Refactor to use hooks pattern",
      "priority": "medium"
    }
  ],
  "learnings": [
    {
      "name": "AsyncThunkErrorHandling",
      "insight": "Specific actionable learning",
      "codeExample": "\`createAsyncThunk('name', async (arg, { rejectWithValue }) => { ... })\`",
      "applicability": "When to apply this learning"
    }
  ]
}

QUALITY RULES:
- Each pattern/learning MUST have a \`codeExample\` with actual code in backticks
- Names must be PascalCase and descriptive (NOT generic like "General" or "Various")
- doRules/dontRules must be specific and actionable (NOT vague like "follow best practices")
- Evidence must reference actual commits or files from the analysis
- Minimum 3 patterns and 2 learnings required
- Skip any insight that lacks concrete code examples or specific guidance`;
  }

  private parseInsightsFromLLMResponse(response: string): SemanticAnalysisResult['semanticInsights'] {
    try {
      // Try to extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);

        // Handle new structured format
        if (parsed.patterns || parsed.learnings) {
          return {
            keyPatterns: this.convertStructuredPatterns(parsed.patterns || []),
            architecturalDecisions: this.convertStructuredDecisions(parsed.architecturalDecisions || []),
            technicalDebt: this.convertStructuredDebt(parsed.technicalDebt || []),
            innovativeApproaches: parsed.innovativeApproaches || [],
            learnings: this.convertStructuredLearnings(parsed.learnings || [])
          };
        }

        // Legacy format fallback
        return {
          keyPatterns: parsed.keyPatterns || [],
          architecturalDecisions: parsed.architecturalDecisions || [],
          technicalDebt: parsed.technicalDebt || [],
          innovativeApproaches: parsed.innovativeApproaches || [],
          learnings: parsed.learnings || []
        };
      }
    } catch (error) {
      log('Failed to parse LLM response as JSON', 'warning', error);
    }

    // Fallback: extract insights from text
    return {
      keyPatterns: this.extractPatternFromText(response, 'pattern'),
      architecturalDecisions: this.extractPatternFromText(response, 'decision|architecture'),
      technicalDebt: this.extractPatternFromText(response, 'debt|improvement|refactor'),
      innovativeApproaches: this.extractPatternFromText(response, 'innovative|creative|novel'),
      learnings: this.extractPatternFromText(response, 'learning|insight|lesson')
    };
  }

  /**
   * Convert structured pattern objects to rich observation strings (bullet-point format)
   * Uses plain text bullet points — no bold markdown (observations are displayed as-is in VKB)
   */
  private convertStructuredPatterns(patterns: any[]): string[] {
    return patterns
      .filter(p => p.name && p.codeExample) // Must have name and code example
      .map(p => {
        const lines = [`${p.name}`];
        if (p.problem) lines.push(`- Problem: ${p.problem}`);
        if (p.solution) lines.push(`- Solution: ${p.solution}`);
        if (p.codeExample) lines.push(`- Example: ${p.codeExample}`);
        if (p.doRules?.length) lines.push(`- DO: ${p.doRules.join('; ')}`);
        if (p.dontRules?.length) lines.push(`- DON'T: ${p.dontRules.join('; ')}`);
        if (p.evidence?.length) lines.push(`- Evidence: ${p.evidence.slice(0, 2).join(', ')}`);
        return lines.join('\n');
      });
  }

  /**
   * Convert structured decision objects to rich observation strings (bullet-point format)
   */
  private convertStructuredDecisions(decisions: any[]): string[] {
    return decisions
      .filter(d => d.name && (d.decision || d.rationale))
      .map(d => {
        const lines = [`${d.name}`];
        if (d.decision) lines.push(`- Decision: ${d.decision}`);
        if (d.rationale) lines.push(`- Rationale: ${d.rationale}`);
        if (d.codeExample) lines.push(`- Example: ${d.codeExample}`);
        if (d.tradeoffs?.length) lines.push(`- Tradeoffs: ${d.tradeoffs.join('; ')}`);
        if (d.evidence?.length) lines.push(`- Evidence: ${d.evidence.slice(0, 2).join(', ')}`);
        return lines.join('\n');
      });
  }

  /**
   * Convert structured debt objects to rich observation strings (bullet-point format)
   */
  private convertStructuredDebt(debt: any[]): string[] {
    return debt
      .filter(d => d.name && d.issue)
      .map(d => {
        const lines = [`${d.name}`];
        if (d.issue) lines.push(`- Issue: ${d.issue}`);
        if (d.location) lines.push(`- Location: ${d.location}`);
        if (d.suggestedFix) lines.push(`- Fix: ${d.suggestedFix}`);
        if (d.priority) lines.push(`- Priority: ${d.priority}`);
        return lines.join('\n');
      });
  }

  /**
   * Convert structured learning objects to rich observation strings (bullet-point format)
   */
  private convertStructuredLearnings(learnings: any[]): string[] {
    return learnings
      .filter(l => l.name && (l.insight || l.codeExample))
      .map(l => {
        const lines = [`${l.name}`];
        if (l.insight) lines.push(`- Insight: ${l.insight}`);
        if (l.codeExample) lines.push(`- Example: ${l.codeExample}`);
        if (l.applicability) lines.push(`- When: ${l.applicability}`);
        return lines.join('\n');
      });
  }

  private extractPatternFromText(text: string, pattern: string): string[] {
    const regex = new RegExp(`(?:${pattern})[^.]*`, 'gi');
    const matches = text.match(regex);
    return matches ? matches.slice(0, 5) : [];
  }

  private generateRuleBasedInsights(
    codeFiles: CodeFile[],
    gitAnalysis: any,
    vibeAnalysis: any,
    crossAnalysis: any
  ): SemanticAnalysisResult['semanticInsights'] {
    // Extract insights from git analysis if available
    const keyPatterns = codeFiles?.length > 0 
      ? [...new Set(codeFiles.flatMap(f => f.patterns))]
      : (gitAnalysis?.patterns || []).map((p: any) => p.name || p);
    
    const architecturalDecisions = gitAnalysis?.architecturalDecisions
      ?.map((d: any) => `${d.type || 'Decision'}: ${d.description || d}`)
      .slice(0, 5) || [];

    // Get technical debt from code analysis or git commits
    const technicalDebt = codeFiles?.length > 0
      ? codeFiles.filter(f => f.complexity > 15)
          .map(f => `High complexity in ${f.path} (${f.complexity})`).slice(0, 3)
      : gitAnalysis?.commits?.filter((c: any) => c.message?.includes('fix') || c.message?.includes('refactor'))
          .map((c: any) => `Technical fix: ${c.message?.substring(0, 50)}...`).slice(0, 3) || [];

    // Generate insights from conversation analysis
    const innovativeApproaches = crossAnalysis?.conversationImplementationMap?.length > 0
      ? crossAnalysis.conversationImplementationMap
          .map((m: any) => `Implemented ${m.implementation?.join(', ') || 'solution'} for: ${m.problem}`)
          .slice(0, 3)
      : vibeAnalysis?.sessions?.map((s: any) => `Development insight from session: ${s.content?.substring(0, 50)}...`).slice(0, 3) || [];

    // Generate meaningful learnings even without code files
    const learnings = [];
    
    if (codeFiles?.length > 0) {
      learnings.push(`Primary development language: ${this.getMostUsedLanguage(codeFiles)}`);
      learnings.push(`Code quality score: ${this.calculateOverallQuality(codeFiles)}%`);
    } else {
      learnings.push(`Analysis based on git history with ${gitAnalysis?.commits?.length || 0} commits`);
      learnings.push(`Repository contains ${gitAnalysis?.totalChanges || 0} total changes`);
    }
    
    learnings.push(`Most common pattern: ${keyPatterns[0] || 'Pattern analysis in progress'}`);
    
    if (gitAnalysis?.summary) {
      learnings.push(`Repository focus: ${gitAnalysis.summary}`);
    }

    log('Generated rule-based insights', 'info', {
      keyPatterns: keyPatterns.length,
      architecturalDecisions: architecturalDecisions.length,
      technicalDebt: technicalDebt.length,
      innovativeApproaches: innovativeApproaches.length,
      learnings: learnings.length
    });

    return {
      keyPatterns,
      architecturalDecisions,
      technicalDebt,
      innovativeApproaches,
      learnings
    };
  }

  private getMostUsedLanguage(codeFiles: CodeFile[]): string {
    const counts = new Map<string, number>();
    codeFiles.forEach(file => {
      counts.set(file.language, (counts.get(file.language) || 0) + 1);
    });
    
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
  }

  private calculateOverallQuality(codeFiles: CodeFile[]): number {
    const avgComplexity = codeFiles.reduce((sum, f) => sum + f.complexity, 0) / codeFiles.length;
    const complexityScore = Math.max(0, 100 - (avgComplexity - 5) * 10);
    
    const patternScore = Math.min(100, codeFiles.flatMap(f => f.patterns).length * 10);
    
    return Math.round((complexityScore + patternScore) / 2);
  }

  private calculateConfidence(codeFiles: CodeFile[], crossAnalysis: any): number {
    let confidence = 0.5; // Base confidence
    
    // More files analyzed = higher confidence
    confidence += Math.min(0.3, codeFiles.length * 0.02);
    
    // Cross-analysis correlations increase confidence
    confidence += Math.min(0.2, (crossAnalysis.gitCodeCorrelation?.length || 0) * 0.05);
    confidence += Math.min(0.2, (crossAnalysis.vibeCodeCorrelation?.length || 0) * 0.05);
    
    return Math.min(1, confidence);
  }

  // Public wrapper methods for coordinator and tools compatibility
  async analyzeSemantics(parameters: any): Promise<SemanticAnalysisResult> {
    const { _context, incremental, git_analysis_results, vibe_analysis_results, code_graph_results, doc_analysis_results } = parameters;

    // Support both direct parameters and context-based parameters
    const gitAnalysis = git_analysis_results || _context?.previousResults?.analyze_git_history;
    const vibeAnalysis = vibe_analysis_results || _context?.previousResults?.analyze_vibe_history;
    const codeGraph = code_graph_results || _context?.previousResults?.index_recent_code || _context?.previousResults?.index_codebase;
    const docAnalysis = doc_analysis_results || _context?.previousResults?.link_documentation;

    log('analyzeSemantics called with all 4 data sources', 'info', {
      hasGitAnalysis: !!gitAnalysis,
      hasVibeAnalysis: !!vibeAnalysis,
      hasCodeGraph: !!codeGraph,
      hasDocAnalysis: !!docAnalysis,
      codeGraphEntities: codeGraph?.statistics?.totalEntities || 0,
      docFilesAnalyzed: docAnalysis?.markdownFiles?.length || docAnalysis?.filesAnalyzed || 0,
      incremental
    });

    return await this.analyzeGitAndVibeData(gitAnalysis, vibeAnalysis, {
      analysisDepth: incremental ? 'surface' : 'deep',
      codeGraphAnalysis: codeGraph,  // Pass code graph data for enhanced analysis
      docAnalysis: docAnalysis  // Pass documentation analysis for context
    });
  }

  async analyzeContent(content: string, context?: any, analysisType?: string): Promise<any> {
    // FIXED: Use the actual content parameter instead of mock data
    // This method is called by insight-generation-agent with real LLM prompts

    log('analyzeContent called with real prompt', 'info', {
      contentLength: content.length,
      hasContext: !!context,
      analysisType: analysisType || 'general',
      contextType: typeof context
    });

    // Check for mock mode BEFORE making any LLM calls
    if (isMockLLMEnabled(this.repositoryPath)) {
      log('LLM Mock mode enabled - returning mock analyzeContent response', 'info');
      const mockDelay = getMockDelay(this.repositoryPath);
      await new Promise(resolve => setTimeout(resolve, mockDelay));

      return {
        insights: `Mock analysis of content (${content.length} chars). Analysis type: ${analysisType || 'general'}. ` +
          'Key findings: Component structure follows best practices. ' +
          'Recommendations: Consider adding type annotations for better maintainability.',
        provider: 'mock',
        confidence: 0.85
      };
    }

    try {
      // Build the full prompt with context if provided
      let fullPrompt = content;
      if (context && typeof context === 'object' && context.context) {
        fullPrompt = `${context.context}\n\n${content}`;
      }

      // Call LLM via unified LLMService
      await this.ensureLLMInitialized();
      const result = await this.llmService.complete({
        messages: [{ role: 'user', content: fullPrompt }],
        taskType: 'content_analysis',
        agentId: 'semantic_analysis',
        maxTokens: 4096,
        temperature: 0.7,
      });

      const response = result.content;

      SemanticAnalyzer.recordMetricsFromExternal({
        provider: result.provider,
        model: result.model,
        inputTokens: result.tokens.input,
        outputTokens: result.tokens.output,
        totalTokens: result.tokens.total,
      });

      log('LLM analysis completed successfully', 'info', {
        responseLength: response.length,
        provider: result.provider,
      });

      return {
        insights: response,
        provider: result.provider,
        confidence: 0.8
      };

    } catch (error) {
      log('analyzeContent failed', 'error', error);
      throw error;
    }
  }

  async analyzeCode(code: string, language?: string, filePath?: string): Promise<any> {
    // Legacy compatibility method  
    const mockFile: CodeFile = {
      path: filePath || 'temp.js',
      content: code,
      language: language || 'javascript',
      size: code.length,
      complexity: this.calculateComplexity(code, language || 'javascript'),
      patterns: this.detectCodePatterns(code, language || 'javascript'),
      functions: this.extractFunctions(code, language || 'javascript'),
      imports: this.extractImports(code, language || 'javascript'),
      changeType: 'modified'
    };

    const codeAnalysis = this.generateCodeAnalysisMetrics([mockFile]);
    
    return {
      analysis: `Code analysis completed for ${language || 'javascript'} file`,
      findings: codeAnalysis.codeQuality.issues,
      recommendations: codeAnalysis.codeQuality.recommendations,
      complexity: mockFile.complexity,
      patterns: mockFile.patterns
    };
  }

  async analyzeRepository(repositoryPath: string, options: any = {}): Promise<any> {
    // Legacy compatibility method
    const mockGitAnalysis = { commits: [], codeEvolution: [] };  
    const mockVibeAnalysis = { sessions: [], problemSolutionPairs: [] };
    
    const result = await this.analyzeGitAndVibeData(mockGitAnalysis, mockVibeAnalysis, {
      maxFiles: options.maxFiles,
      includePatterns: options.includePatterns,
      excludePatterns: options.excludePatterns,
      analysisDepth: 'comprehensive'
    });
    
    return {
      structure: `Repository contains ${result.codeAnalysis.filesAnalyzed} files in ${Object.keys(result.codeAnalysis.languageDistribution).length} languages`,
      patterns: result.semanticInsights.keyPatterns,
      insights: result.semanticInsights.learnings.join('. '),
      complexity: result.codeAnalysis.complexityMetrics.averageComplexity
    };
  }

  async extractPatterns(source: string, patternTypes?: string[], context?: string): Promise<string[]> {
    // Legacy compatibility - this should be private but tools.ts expects it public
    const patterns = this.detectCodePatterns(source, 'generic');
    return patterns.filter((pattern: any) =>
      !patternTypes || patternTypes.some(type =>
        pattern.toLowerCase().includes(type.toLowerCase())
      )
    );
  }

  /**
   * Analyze documentation semantics - LLM analysis of docstrings and documentation content
   *
   * This method bridges the gap where docstrings and documentation are captured but not
   * semantically analyzed. It extracts meaning, patterns, and insights from:
   * 1. Code entity docstrings (purpose, params, usage patterns, warnings)
   * 2. Documentation prose around code references (tutorials, best practices, examples)
   */
  async analyzeDocumentationSemantics(params: {
    code_entities?: any[];
    doc_analysis?: {
      links?: Array<{
        codeReference: string;
        context: string;
        documentPath: string;
        confidence: number;
      }>;
      documents?: Array<{
        path: string;
        title?: string;
        codeReferences: string[];
      }>;
    };
    raw_code_entities?: Array<{
      id: string;
      name: string;
      type: string;
      docstring?: string;
      signature?: string;
      filePath: string;
    }>;
    batch_size?: number;
    min_docstring_length?: number;
    parallel_batches?: number;  // Number of batches to process in parallel
  }): Promise<{
    entityAnalyses: Record<string, {
      purpose: string;
      parameters: string[];
      returnValue: string;
      usagePatterns: string[];
      warnings: string[];
      relatedEntities: string[];
      semanticScore: number;
    }>;
    proseAnalyses: Array<{
      documentPath: string;
      summary: string;
      tutorials: string[];
      bestPractices: string[];
      warnings: string[];
      linkedEntities: string[];
    }>;
    statistics: {
      entitiesAnalyzed: number;
      entitiesSkipped: number;
      documentsAnalyzed: number;
      patternsExtracted: number;
    };
    enrichedObservations: Array<{
      entityName: string;
      observations: string[];
    }>;
  }> {
    const batchSize = params.batch_size || 20;
    const minDocstringLength = params.min_docstring_length || 50;
    const parallelBatches = params.parallel_batches || 1;  // Default to sequential for backwards compatibility

    log('Starting documentation semantics analysis', 'info', {
      codeEntitiesCount: params.code_entities?.length || 0,
      rawCodeEntitiesCount: params.raw_code_entities?.length || 0,
      docLinksCount: params.doc_analysis?.links?.length || 0,
      documentsCount: params.doc_analysis?.documents?.length || 0,
      batchSize,
      minDocstringLength,
      parallelBatches
    });

    const entityAnalyses: Record<string, any> = {};
    const proseAnalyses: any[] = [];
    const enrichedObservations: Array<{ entityName: string; observations: string[] }> = [];
    let entitiesAnalyzed = 0;
    let entitiesSkipped = 0;
    let patternsExtracted = 0;

    // Phase 1: Analyze docstrings from raw code entities
    const rawEntities = params.raw_code_entities || [];
    const entitiesWithDocstrings = rawEntities.filter(entity =>
      entity.docstring &&
      entity.docstring.length >= minDocstringLength &&
      ['class', 'function', 'method'].includes(entity.type)
    );

    log(`Filtered ${entitiesWithDocstrings.length} entities with meaningful docstrings`, 'info');

    // Split entities into batches
    const allBatches: typeof entitiesWithDocstrings[] = [];
    for (let i = 0; i < entitiesWithDocstrings.length; i += batchSize) {
      allBatches.push(entitiesWithDocstrings.slice(i, i + batchSize));
    }

    // Process batches in parallel chunks for better performance
    const processBatch = async (batch: typeof entitiesWithDocstrings, batchIndex: number) => {
      try {
        const batchAnalyses = await this.analyzeDocstringBatch(batch);
        return { success: true, analyses: batchAnalyses, batchIndex };
      } catch (error) {
        log(`Failed to analyze docstring batch ${batchIndex}`, 'warning', error);
        return { success: false, analyses: [], batchIndex, skipped: batch.length };
      }
    };

    // Process in parallel chunks of parallelBatches at a time
    for (let chunkStart = 0; chunkStart < allBatches.length; chunkStart += parallelBatches) {
      const chunk = allBatches.slice(chunkStart, chunkStart + parallelBatches);
      const results = await Promise.all(
        chunk.map((batch, idx) => processBatch(batch, chunkStart + idx))
      );

      // Aggregate results from parallel batch processing
      for (const result of results) {
        if (result.success) {
          for (const analysis of result.analyses) {
            entityAnalyses[analysis.entityId] = {
              purpose: analysis.purpose,
              parameters: analysis.parameters,
              returnValue: analysis.returnValue,
              usagePatterns: analysis.usagePatterns,
              warnings: analysis.warnings,
              relatedEntities: analysis.relatedEntities,
              semanticScore: analysis.semanticScore
            };

            // Create enriched observations for this entity
            const observations: string[] = [];
            if (analysis.purpose) {
              observations.push(`Purpose: ${analysis.purpose}`);
            }
            if (analysis.usagePatterns.length > 0) {
              observations.push(`Usage: ${analysis.usagePatterns.join('; ')}`);
            }
            if (analysis.warnings.length > 0) {
              observations.push(`Caveats: ${analysis.warnings.join('; ')}`);
            }
            if (analysis.relatedEntities.length > 0) {
              observations.push(`Related: ${analysis.relatedEntities.join(', ')}`);
            }

            if (observations.length > 0) {
              enrichedObservations.push({
                entityName: analysis.entityName,
                observations
              });
            }

            entitiesAnalyzed++;
            patternsExtracted += analysis.usagePatterns.length;
          }
        } else {
          entitiesSkipped += result.skipped || 0;
        }
      }
    }

    // Phase 2: Analyze documentation prose (also parallelized)
    const docLinks = params.doc_analysis?.links || [];
    const documents = params.doc_analysis?.documents || [];

    // Group links by document for context-aware analysis
    const linksByDocument = new Map<string, typeof docLinks>();
    for (const link of docLinks) {
      if (!linksByDocument.has(link.documentPath)) {
        linksByDocument.set(link.documentPath, []);
      }
      linksByDocument.get(link.documentPath)!.push(link);
    }

    // Filter to only docs with multiple code references
    const docsToAnalyze = Array.from(linksByDocument.entries())
      .filter(([_, links]) => links.length >= 2);

    // Process documents in parallel chunks
    const processDocument = async (docPath: string, links: typeof docLinks) => {
      try {
        const docMetadata = documents.find(d => d.path === docPath);
        const proseAnalysis = await this.analyzeDocumentProse(docPath, links, docMetadata);
        return { success: true, analysis: proseAnalysis };
      } catch (error) {
        log(`Failed to analyze document prose: ${docPath}`, 'warning', error);
        return { success: false, analysis: null };
      }
    };

    // Process in parallel chunks of parallelBatches at a time
    for (let chunkStart = 0; chunkStart < docsToAnalyze.length; chunkStart += parallelBatches) {
      const chunk = docsToAnalyze.slice(chunkStart, chunkStart + parallelBatches);
      const results = await Promise.all(
        chunk.map(([docPath, links]) => processDocument(docPath, links))
      );

      for (const result of results) {
        if (result.success && result.analysis) {
          proseAnalyses.push(result.analysis);
          patternsExtracted += result.analysis.bestPractices.length;
        }
      }
    }

    const result = {
      entityAnalyses,
      proseAnalyses,
      statistics: {
        entitiesAnalyzed,
        entitiesSkipped,
        documentsAnalyzed: proseAnalyses.length,
        patternsExtracted
      },
      enrichedObservations
    };

    log('Documentation semantics analysis completed', 'info', result.statistics);

    return result;
  }

  /**
   * Analyze a batch of docstrings using LLM
   */
  private async analyzeDocstringBatch(entities: Array<{
    id: string;
    name: string;
    type: string;
    docstring?: string;
    signature?: string;
    filePath: string;
  }>): Promise<Array<{
    entityId: string;
    entityName: string;
    purpose: string;
    parameters: string[];
    returnValue: string;
    usagePatterns: string[];
    warnings: string[];
    relatedEntities: string[];
    semanticScore: number;
  }>> {
    // Check for mock mode BEFORE making any LLM calls
    if (isMockLLMEnabled(this.repositoryPath)) {
      log('LLM Mock mode enabled - returning mock docstring analysis', 'info');
      const mockDelay = getMockDelay(this.repositoryPath);
      await new Promise(resolve => setTimeout(resolve, mockDelay));

      // Return mock analysis for each entity
      return entities.map(entity => ({
        entityId: entity.id,
        entityName: entity.name,
        purpose: `Mock purpose for ${entity.type} ${entity.name}: Handles ${entity.type}-specific logic`,
        parameters: ['param1: Mock parameter description', 'options: Configuration object'],
        returnValue: 'Mock return value description',
        usagePatterns: [`Use ${entity.name} for standard ${entity.type} operations`, 'Follow existing patterns in the codebase'],
        warnings: [],
        relatedEntities: [],
        semanticScore: 0.75
      }));
    }

    const prompt = `Analyze these code docstrings and extract semantic information for each.

For each entity, provide:
1. Purpose: What does this code do? (1-2 sentences)
2. Parameters: What inputs does it accept? (list of param descriptions)
3. Return Value: What does it return?
4. Usage Patterns: How should it be used? (list of usage guidelines)
5. Warnings: Any caveats, deprecated notices, or gotchas?
6. Related Entities: What other code does it reference or depend on?

Entities to analyze:
${entities.map((e, idx) => `
[${idx + 1}] ${e.type} ${e.name}
File: ${e.filePath}
${e.signature ? `Signature: ${e.signature}` : ''}
Docstring:
${e.docstring}
`).join('\n---\n')}

Respond with a JSON array where each element has:
{
  "index": <1-based index>,
  "purpose": "...",
  "parameters": ["param1: description", "param2: description"],
  "returnValue": "...",
  "usagePatterns": ["pattern1", "pattern2"],
  "warnings": ["warning1"],
  "relatedEntities": ["EntityName1", "EntityName2"],
  "semanticScore": <0.0-1.0 quality score>
}`;

    try {
      await this.ensureLLMInitialized();
      const result = await this.llmService.complete({
        messages: [{ role: 'user', content: prompt }],
        taskType: 'docstring_analysis',
        agentId: 'semantic_analysis',
        maxTokens: 4096,
        temperature: 0.3,
      });

      const response = result.content;

      SemanticAnalyzer.recordMetricsFromExternal({
        provider: result.provider,
        model: result.model,
        inputTokens: result.tokens.input,
        outputTokens: result.tokens.output,
        totalTokens: result.tokens.total,
      });

      // Parse JSON response
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        throw new Error('No JSON array found in LLM response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return parsed.map((item: any) => {
        const entity = entities[item.index - 1];
        return {
          entityId: entity.id,
          entityName: entity.name,
          purpose: item.purpose || '',
          parameters: item.parameters || [],
          returnValue: item.returnValue || '',
          usagePatterns: item.usagePatterns || [],
          warnings: item.warnings || [],
          relatedEntities: item.relatedEntities || [],
          semanticScore: item.semanticScore || 0.5
        };
      });

    } catch (error: any) {
      // NO FALLBACK: Docstring analysis requires LLM for quality results
      log('Docstring batch analysis failed - NO FALLBACK', 'error', error);
      throw new Error(
        `SemanticAnalysisAgent: Docstring batch analysis failed.\n` +
        `Error: ${error.message}\n` +
        `Entities to analyze: ${entities.length}\n\n` +
        `This error indicates the LLM service failed to analyze docstrings. ` +
        `Check LLM provider status and API key validity.`
      );
    }
  }

  /**
   * Analyze documentation prose for a single document
   */
  private async analyzeDocumentProse(
    docPath: string,
    links: Array<{ codeReference: string; context: string; confidence: number }>,
    metadata?: { title?: string; codeReferences: string[] }
  ): Promise<{
    documentPath: string;
    summary: string;
    tutorials: string[];
    bestPractices: string[];
    warnings: string[];
    linkedEntities: string[];
  } | null> {
    // Check for mock mode BEFORE making any LLM calls
    if (isMockLLMEnabled(this.repositoryPath)) {
      log('LLM Mock mode enabled - returning mock document prose analysis', 'info');
      const mockDelay = getMockDelay(this.repositoryPath);
      await new Promise(resolve => setTimeout(resolve, mockDelay));

      return {
        documentPath: docPath,
        summary: `Mock summary: Documentation covers ${links.length} code entities with usage patterns and examples.`,
        tutorials: ['Mock tutorial: Follow the setup guide', 'Mock tutorial: Configure settings'],
        bestPractices: ['Mock practice: Use consistent naming', 'Mock practice: Add error handling'],
        warnings: [],
        linkedEntities: links.map(l => l.codeReference)
      };
    }

    // Collect context snippets from links
    const contextSnippets = links
      .filter(l => l.context && l.context.length > 50)
      .slice(0, 10)
      .map(l => `[${l.codeReference}]: ${l.context}`);

    if (contextSnippets.length < 2) {
      return null; // Not enough content to analyze
    }

    const prompt = `Analyze this documentation content and extract useful patterns.

Document: ${metadata?.title || docPath}
Code References: ${links.map(l => l.codeReference).join(', ')}

Documentation snippets:
${contextSnippets.join('\n\n')}

Extract and respond with JSON:
{
  "summary": "Brief summary of what this documentation covers",
  "tutorials": ["Step-by-step guide extracted", "Another tutorial if present"],
  "bestPractices": ["Best practice 1", "Best practice 2"],
  "warnings": ["Any warnings or caveats mentioned"],
  "linkedEntities": ["Code entities discussed in this doc"]
}`;

    try {
      await this.ensureLLMInitialized();
      const result = await this.llmService.complete({
        messages: [{ role: 'user', content: prompt }],
        taskType: 'document_analysis',
        agentId: 'semantic_analysis',
        maxTokens: 2048,
        temperature: 0.3,
      });

      const response = result.content;

      SemanticAnalyzer.recordMetricsFromExternal({
        provider: result.provider,
        model: result.model,
        inputTokens: result.tokens.input,
        outputTokens: result.tokens.output,
        totalTokens: result.tokens.total,
      });

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        documentPath: docPath,
        summary: parsed.summary || '',
        tutorials: parsed.tutorials || [],
        bestPractices: parsed.bestPractices || [],
        warnings: parsed.warnings || [],
        linkedEntities: parsed.linkedEntities || links.map(l => l.codeReference)
      };

    } catch (error) {
      log(`Document prose analysis failed for ${docPath}`, 'warning', error);
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Per-Entity Code Analysis (Wave Integration)
  // --------------------------------------------------------------------------

  /**
   * Analyze code for a single entity, producing deep observations and analysis artifacts.
   * Designed for per-entity wave integration -- each wave agent calls this for its entities.
   *
   * @param input - Entity context and scoped code files
   * @returns Deep observations, analysis artifacts, and trace data
   * @throws Error if LLM call fails (caller handles fallback)
   */
  async analyzeEntityCode(input: AnalyzeEntityCodeInput): Promise<AnalyzeEntityCodeResult> {
    await this.ensureLLMInitialized();
    const startTime = Date.now();

    // Read code file contents (limit to 5 files, 300 lines each)
    const fileContents: { path: string; content: string }[] = [];
    const filesToRead = input.codeFiles.slice(0, 5);

    for (const filePath of filesToRead) {
      try {
        const absolutePath = path.resolve(this.repositoryPath, filePath);
        const content = fs.readFileSync(absolutePath, 'utf-8');
        const lines = content.split('\n');
        const truncated = lines.slice(0, 300).join('\n');
        fileContents.push({
          path: filePath,
          content: truncated + (lines.length > 300 ? '\n// ... truncated ...' : ''),
        });
      } catch {
        log(`[SemanticAnalysisAgent] Could not read file: ${filePath}`, 'warning');
      }
    }

    if (fileContents.length === 0) {
      throw new Error(`No readable code files for entity "${input.entityName}"`);
    }

    // Build focused analysis prompt
    const parentContextBlock = input.parentContext.length > 0
      ? `\n## Parent Context\nThe parent entity has these observations:\n${input.parentContext.map(o => `- ${o}`).join('\n')}\n`
      : '';

    const codeBlock = fileContents.map(f =>
      `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``
    ).join('\n\n');

    // Inject CGR context as a dedicated section if provided
    const cgrBlock = input.cgrContext
      ? `\n## Code Graph Evidence\n${input.cgrContext}\n`
      : '';

    const cgrInstructions = input.cgrContext
      ? `\nIf <code_graph> data is provided above, reference it in your observations. Prefix observations grounded in code graph data with [LLM+CGR]. Prefix observations from your own analysis with [LLM].`
      : '';

    // Stage 3 — the work record. Already rendered by `formatSessionFacts`,
    // which carries its own [SESSION] tagging instruction, so there is no
    // second instruction string to keep in sync here.
    const sessionBlock = input.sessionContext || '';

    const sessionInstructions = input.sessionContext
      ? `\nThe work record above is evidence too. An observation that rests on it — what broke, what was decided, why something is the way it is — is worth more than a restatement of the file listing, and MUST be prefixed [SESSION] (or [SESSION+CGR] when the code graph confirms it).`
      : '';

    const prompt = `You are analyzing the "${input.entityName}" component (type: ${input.entityType}) of a software project.
${parentContextBlock}${cgrBlock}${sessionBlock}
## Code Files
${codeBlock}

## Instructions
Analyze this code component and produce a JSON response with:
1. "observations" - An array of 5+ detailed multi-paragraph observations about architecture, patterns, trade-offs, and implementation details. Each observation MUST reference specific files/functions. AVOID generic statements.${cgrInstructions}${sessionInstructions}
2. "patterns" - An array of architectural patterns discovered (e.g. "Observer pattern for event handling", "Repository pattern for data access")
3. "architectureNotes" - An array of architecture observations (e.g. "Uses dependency injection via constructor", "Tight coupling between X and Y")
4. "codeReferences" - An array of specific file/line references grounding the analysis (e.g. "src/auth.ts:45 - JWT validation")
5. "evidenceGap" - Boolean. Set TRUE when the code files above do NOT implement or reference "${input.entityName}" — i.e. you would have to infer the component from its parent/sibling descriptions or from thematically similar code in unrelated files. Set FALSE only when the supplied code actually contains this component.
6. "evidenceGapReason" - One sentence naming what is missing, when evidenceGap is true. Omit otherwise.

Setting evidenceGap TRUE is a correct and useful answer, not a failure. File retrieval selects candidates by FILENAME substring, so it routinely hands you a parent component's general neighbourhood rather than this entity's implementation. Saying so stops a confident document being built on inference; guessing does not.

Respond ONLY with a JSON object. Do not include markdown fences or any text outside the JSON.`;

    // Make LLM call
    const result = await this.llmService.complete({
      messages: [{ role: 'user', content: prompt }],
      taskType: 'semantic_analysis',
      agentId: 'semantic_analysis_entity',
      maxTokens: 4096,
      temperature: 0.7,
      timeout: 60_000,
    });

    const durationMs = Date.now() - startTime;

    // Parse response -- strip markdown fences if present
    let responseText = result.content.trim();
    const fenceMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      responseText = fenceMatch[1].trim();
    }

    let parsed: {
      observations?: string[];
      patterns?: string[];
      architectureNotes?: string[];
      codeReferences?: string[];
      evidenceGap?: boolean;
      evidenceGapReason?: string;
    };
    try {
      parsed = JSON.parse(responseText);
    } catch {
      log(`[SemanticAnalysisAgent] Failed to parse LLM response as JSON for entity "${input.entityName}"`, 'warning');
      throw new Error(`LLM response was not valid JSON for entity "${input.entityName}"`);
    }

    // Build result
    const artifacts: AnalysisArtifacts = {
      patterns: parsed.patterns || [],
      architectureNotes: parsed.architectureNotes || [],
      codeReferences: parsed.codeReferences || [],
    };

    const traceData: EntityTraceData = {
      llmCallCount: 1,
      totalDurationMs: durationMs,
      model: result.model,
      provider: result.provider,
      agentType: 'SemanticAnalysisAgent',
    };

    log(`[SemanticAnalysisAgent] analyzeEntityCode complete for "${input.entityName}"`, 'info', {
      observations: (parsed.observations || []).length,
      patterns: artifacts.patterns.length,
      durationMs,
      provider: result.provider,
      model: result.model,
    });

    if (parsed.evidenceGap === true) {
      log(
        `[SemanticAnalysisAgent] evidence gap for "${input.entityName}": ${parsed.evidenceGapReason ?? 'supplied files do not implement it'}`,
        'warning',
      );
    }

    return {
      observations: parsed.observations || [],
      artifacts,
      traceData,
      // Structured, not prose. The analyser has always been able to notice that
      // the files it was handed do not implement the entity — it said so in an
      // observation and nothing downstream could act on it, so the insight
      // generator built a full technical document out of inference anyway.
      evidenceGap: parsed.evidenceGap === true,
      ...(parsed.evidenceGapReason ? { evidenceGapReason: parsed.evidenceGapReason } : {}),
    };
  }

  /**
   * Auto-tag observations with provenance prefixes based on CGR context presence.
   *
   * - If hadCgrContext is true: scan each observation for code entity references
   *   (PascalCase identifiers, file paths). If found and no tag present, prepend [LLM+CGR].
   *   Otherwise prepend [LLM].
   * - If hadCgrContext is false: prepend [LLM] to any untagged observations.
   * - Skips observations already starting with [CGR], [LLM], or [LLM+CGR].
   *
   * @param observations - Raw observations from LLM response
   * @param hadCgrContext - Whether CGR context was injected into the LLM prompt
   * @returns Tagged observations
   */
  /**
   * Coerce one LLM-returned observation to a string.
   *
   * The parse site types the model's JSON as `{ observations?: string[] }` and
   * casts — no validation — so a model that answers with OBJECTS instead of
   * strings type-checks fine and corrupts the data downstream. That is exactly
   * what happened: `tagPattern.test(obj)` stringifies to "[object Object]",
   * fails to match, and the tagger emits the literal string
   * "[LLM] [object Object]". Twelve wave-analysis entities had their entire
   * description replaced by seven repetitions of it — the rendered entity
   * panel showed nothing else.
   *
   * A string wins. An object gets its first plausible text field. Anything
   * else is JSON-stringified rather than silently coerced, so a future shape
   * change is legible in the data instead of becoming "[object Object]" again.
   */
  static normalizeObservation(obs: unknown): string {
    if (typeof obs === 'string') return obs;
    if (obs && typeof obs === 'object') {
      const rec = obs as Record<string, unknown>;
      for (const key of ['observation', 'text', 'description', 'content', 'note', 'summary', 'value']) {
        const v = rec[key];
        if (typeof v === 'string' && v.trim().length > 0) return v;
      }
      try {
        return JSON.stringify(obs);
      } catch {
        return '';
      }
    }
    return obs === null || obs === undefined ? '' : String(obs);
  }

  static autoTagObservations(observations: readonly unknown[], hadCgrContext: boolean): string[] {
    // [SESSION] joins the set in stage 3: an observation resting on the work
    // record rather than on the source files. It MUST be recognised here — an
    // unrecognised prefix is not left alone, it is prefixed again, and the
    // corpus would fill with `[LLM] [SESSION] …` strings whose provenance
    // reads as the opposite of what it is.
    const tagPattern = /^\[(CGR|LLM|LLM\+CGR|SESSION|SESSION\+CGR)\]/;
    const codeRefPattern = /[A-Z][a-z]+[A-Z]|\.(ts|js|py|yaml|json)\b|\/[\w-]+\//;

    return observations
      .map(raw => SemanticAnalysisAgent.normalizeObservation(raw))
      .filter(obs => obs.trim().length > 0)
      .map(obs => {
        // Skip already-tagged observations
        if (tagPattern.test(obs)) return obs;

        if (hadCgrContext && codeRefPattern.test(obs)) {
          return `[LLM+CGR] ${obs}`;
        }
        return `[LLM] ${obs}`;
      });
  }
}