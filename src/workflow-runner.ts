#!/usr/bin/env node
/**
 * Standalone workflow runner - runs in a separate process from MCP server
 * This allows workflows to survive MCP disconnections
 *
 * Usage: node workflow-runner.js <config-file-path>
 *
 * Config file is JSON with:
 * - workflowId: string
 * - workflowName: string
 * - repositoryPath: string
 * - parameters: object
 * - progressFile: string (where to write progress updates)
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CoordinatorAgent } from './agents/coordinator.js';
import { log } from './logging.js';
import { dispatch } from './workflow-state-machine.js';
import { InvalidTransitionError } from './shared/workflow-types/transitions.js';
import { writeTerminalState } from './workflow-runner-terminal-write.js';
import { requireTenant } from './scope.js';
import { runCoordinatorWorkflow } from './run-coordinator-workflow.js';

// ============================================================================
// CRASH RECOVERY: Module-level state for signal handlers
// ============================================================================
let cleanupState: {
  progressFile?: string;
  pidFile?: string;
  configPath?: string;
  startTime?: Date;
  workflowId?: string;
  coordinator?: CoordinatorAgent;
  heartbeatInterval?: NodeJS.Timeout;
  watchdogTimer?: NodeJS.Timeout;
  isShuttingDown: boolean;
} = { isShuttingDown: false };

/**
 * Graceful cleanup function for signal handlers
 * Writes final progress, cleans up files, and shuts down coordinator
 */
async function gracefulCleanup(reason: string, exitCode: number = 1): Promise<void> {
  if (cleanupState.isShuttingDown) {
    log('[WorkflowRunner] Cleanup already in progress, skipping duplicate', 'warning');
    return;
  }
  cleanupState.isShuttingDown = true;

  log(`[WorkflowRunner] Graceful cleanup initiated: ${reason}`, 'warning');

  // Clear intervals/timers first
  if (cleanupState.heartbeatInterval) {
    clearInterval(cleanupState.heartbeatInterval);
  }
  if (cleanupState.watchdogTimer) {
    clearTimeout(cleanupState.watchdogTimer);
  }

  // Dispatch fail event via state machine (subscriber writes progress file)
  try {
    dispatch({ type: 'fail', error: reason, step: 'crash-recovery' });
  } catch (e) {
    if (!(e instanceof InvalidTransitionError)) {
      log('[WorkflowRunner] Failed to dispatch fail event during cleanup', 'error', e);
    }
  }

  // Shutdown coordinator
  if (cleanupState.coordinator) {
    try {
      await cleanupState.coordinator.shutdown();
      log('[WorkflowRunner] Coordinator shutdown complete', 'info');
    } catch (e) {
      log('[WorkflowRunner] Error during coordinator shutdown', 'error', e);
    }
  }

  // Clean up PID file
  if (cleanupState.pidFile) {
    try {
      fs.unlinkSync(cleanupState.pidFile);
    } catch (e) {
      // Ignore - may already be deleted
    }
  }

  // Clean up config file
  if (cleanupState.configPath) {
    try {
      fs.unlinkSync(cleanupState.configPath);
    } catch (e) {
      // Ignore
    }
  }

  log(`[WorkflowRunner] Cleanup complete, exiting with code ${exitCode}`, 'info');
  process.exit(exitCode);
}

// ============================================================================
// SIGNAL HANDLERS: Set up process-level crash recovery
// ============================================================================
process.on('SIGTERM', () => {
  log('[WorkflowRunner] SIGTERM received', 'warning');
  gracefulCleanup('Process terminated (SIGTERM)', 130);
});

process.on('SIGINT', () => {
  log('[WorkflowRunner] SIGINT received', 'warning');
  gracefulCleanup('Process interrupted (SIGINT)', 130);
});

process.on('unhandledRejection', (reason, promise) => {
  // Write to stdout/stderr which now goes to log file
  console.error(`[${new Date().toISOString()}] UNHANDLED REJECTION:`, reason);
  log('[WorkflowRunner] Unhandled promise rejection', 'error', { reason, promise: String(promise) });
  gracefulCleanup(`Unhandled rejection: ${reason}`, 1);
});

process.on('uncaughtException', (error) => {
  // Write to stdout/stderr which now goes to log file
  console.error(`[${new Date().toISOString()}] UNCAUGHT EXCEPTION:`, error);
  console.error('Stack:', error.stack);
  log('[WorkflowRunner] Uncaught exception', 'error', error);
  gracefulCleanup(`Uncaught exception: ${error.message}`, 1);
});

// Additional exit monitoring for debugging silent crashes
process.on('beforeExit', (code) => {
  console.log(`[${new Date().toISOString()}] BEFORE EXIT: code=${code}`);
  console.log(`CleanupState: isShuttingDown=${cleanupState.isShuttingDown}, workflowId=${cleanupState.workflowId}`);
});

process.on('exit', (code) => {
  // This is the LAST thing that runs - use sync logging only
  try {
    const mem = process.memoryUsage();
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] EXIT: code=${code}, heap=${Math.round(mem.heapUsed/1024/1024)}MB, rss=${Math.round(mem.rss/1024/1024)}MB`);
    // Also write to a dedicated crash log file for debugging
    const crashLogPath = cleanupState.progressFile?.replace('workflow-progress.json', 'workflow-exit.log');
    if (crashLogPath) {
      // Use the already-imported fs module (ESM compatible)
      fs.appendFileSync(crashLogPath, `[${timestamp}] EXIT: code=${code}, workflowId=${cleanupState.workflowId}, heap=${Math.round(mem.heapUsed/1024/1024)}MB, rss=${Math.round(mem.rss/1024/1024)}MB, isShuttingDown=${cleanupState.isShuttingDown}\n`);
    }
  } catch (e) {
    // Ignore - can't do much at exit time
  }
});

interface WorkflowConfig {
  workflowId: string;
  workflowName: string;
  repositoryPath: string;
  parameters: Record<string, any>;
  progressFile: string;
  pidFile: string;
}


/**
 * Log memory usage to console (goes to log file)
 */
function logMemoryUsage(context: string): void {
  const mem = process.memoryUsage();
  const formatMB = (bytes: number) => `${Math.round(bytes / 1024 / 1024)}MB`;
  log(`MEMORY (${context}): heap=${formatMB(mem.heapUsed)}/${formatMB(mem.heapTotal)}, rss=${formatMB(mem.rss)}, external=${formatMB(mem.external)}`, 'debug');
}

async function main(): Promise<void> {
  const configPath = process.argv[2];

  // Startup banner
  log(`${'='.repeat(60)}`, 'info');
  log(`WORKFLOW RUNNER STARTING`, 'info');
  log(`PID: ${process.pid}, Node: ${process.version}`, 'info');
  log(`Config: ${configPath}`, 'info');
  logMemoryUsage('startup');
  log(`${'='.repeat(60)}`, 'info');

  if (!configPath) {
    process.stderr.write('Usage: workflow-runner <config-file-path>\n');
    process.exit(1);
  }

  let config: WorkflowConfig;

  try {
    const configContent = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(configContent);
  } catch (e) {
    log('Failed to read config file', 'error', e);
    process.exit(1);
  }

  const { workflowId, workflowName, repositoryPath, parameters, progressFile, pidFile } = config;

  // Populate cleanup state for signal handlers
  cleanupState.configPath = configPath;
  cleanupState.progressFile = progressFile;
  cleanupState.pidFile = pidFile;
  cleanupState.workflowId = workflowId;

  // Write PID file so parent can track us
  fs.writeFileSync(pidFile, String(process.pid));

  const startTime = new Date();
  cleanupState.startTime = startTime;

  log(`[WorkflowRunner] Starting workflow: ${workflowName} (${workflowId})`, 'info', {
    pid: process.pid,
    repositoryPath,
    parameters
  });

  // Read debug settings from progress file if they were pre-set by tools.ts,
  // and forward them to whichever run function owns this workflow — both own
  // the state machine and the progress file from here on.
  let presetConfig: Record<string, any> = {};
  if (fs.existsSync(progressFile)) {
    try {
      presetConfig = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
    } catch { /* ignore */ }
  }
  const runConfig = {
    singleStepMode: presetConfig.singleStepMode || parameters?.singleStepMode || false,
    mockLLM: presetConfig.mockLLM || parameters?.mockLLM || false,
    mockLLMDelay: presetConfig.mockLLMDelay,
    llmMode: presetConfig.llmState?.globalMode || parameters?.llmMode || 'public',
    stepIntoSubsteps: presetConfig.stepIntoSubsteps || parameters?.stepIntoSubsteps || false,
  };

  const removeRunFiles = () => {
    try { fs.unlinkSync(pidFile); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(configPath); } catch (e) { /* ignore */ }
  };

  // Wave-analysis routing -- separate from coordinator path.
  //
  // Both runs live in their own modules (run-wave-analysis.ts,
  // run-coordinator-workflow.ts) because obs-api runs the same workflows
  // in-process: km-core's LevelDB is single-owner, so a run spawned out here
  // cannot open it while obs-api holds the lock. This path keeps working
  // wherever nothing else owns the store — it just passes no kmStore, so a
  // private store is opened exactly as before.
  if (workflowName === 'wave-analysis') {
    const { runWaveAnalysis } = await import('./run-wave-analysis.js');

    const result = await runWaveAnalysis({
      repositoryPath,
      // Strict: this becomes the wave adapter's team, i.e. the tenant stamped
      // on every entity the run writes.
      team: parameters?.team ?? (await requireTenant(repositoryPath)),
      progressFile,
      config: runConfig,
    });

    removeRunFiles();
    process.exit(result.success ? 0 : 1);
  }

  const result = await runCoordinatorWorkflow({
    repositoryPath,
    workflowName,
    team: parameters?.team,
    parameters,
    progressFile,
    config: runConfig,
    onCoordinator: (coordinator) => { cleanupState.coordinator = coordinator; },
    // A spawned runner can simply die; the signal-handler cleanup does the rest.
    onTimeout: (reason) => { gracefulCleanup(reason, 1); },
  });

  log(`[WorkflowRunner] Workflow finished: ${result.status}`, 'info', {
    duration: `${Math.round((Date.now() - startTime.getTime()) / 1000)}s`,
    steps: result.steps,
    error: result.error,
  });

  // runCoordinatorWorkflow already shut the coordinator down.
  cleanupState.coordinator = undefined;
  removeRunFiles();
  if (!result.success) process.exit(1);
}

// Run main
main().then(() => {
  log('[WorkflowRunner] Main function completed, exiting', 'info');
  process.exit(0);
}).catch(e => {
  // Phase 42 Plan 07 — log the actual error message/stack instead of an empty
  // Data:{} (the log() helper doesn't unwrap Error objects' message/stack).
  const errMsg = e instanceof Error ? (e.stack || e.message) : String(e);
  process.stderr.write(`[workflow-runner] Fatal error: ${errMsg}\n`);
  log('Fatal error in workflow runner', 'error', { message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });

  // Phase 42 Plan 07 — SC#4 belt-and-braces extension. runWaveAnalysis()
  // catches everything the run itself throws and writes its own terminal
  // state, but errors fired BEFORE the wave-analysis branch is reached (config
  // parsing, the state-machine start, the dynamic import itself — the
  // Surprise #5 mode was the WaveController constructor's now-fixed CommonJS
  // require() blowing up under ESM) still escape to here. Without this
  // write, the progress file stays `status: 'running'` forever from the
  // dashboard's perspective (Plan 02 VERIFY-FAIL.md captured this exact
  // mode at 12:35:07Z).
  //
  // We read the progress file path from cleanupState (populated by
  // main() once config is parsed). If main() crashed before reaching
  // that population (config-read failure), progressFile is undefined
  // and we have no destination to write — that's an acceptable
  // degradation since the dashboard never started tracking the run.
  if (cleanupState.progressFile) {
    try {
      writeTerminalState(cleanupState.progressFile, 'failed', undefined, {
        error: e instanceof Error ? e.message : String(e),
        step: 'pre-wave-fatal',
      });
    } catch (writeErr) {
      // Best-effort — terminal write must never throw past process.exit().
      process.stderr.write(
        `[workflow-runner] terminal write in outer catch failed: ${
          writeErr instanceof Error ? writeErr.message : String(writeErr)
        }\n`,
      );
    }
  }

  process.exit(1);
});
