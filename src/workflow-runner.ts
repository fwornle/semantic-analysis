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
import { CoordinatorAgent } from './agents/coordinator.js';
import { log } from './logging.js';
import { loadAllWorkflows, getConfigDir, loadWorkflowRunnerConfig } from './utils/workflow-loader.js';
import { dispatch, subscribe, reset, createProgressFileSubscriber } from './workflow-state-machine.js';
import { InvalidTransitionError } from './shared/workflow-types/transitions.js';
import { writeTerminalState } from './workflow-runner-terminal-write.js';

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

// Batch step names for phase separation - derived from workflow YAML definitions
function getBatchStepNames(): Set<string> {
  try {
    const configDir = getConfigDir();
    const workflows = loadAllWorkflows(configDir);
    const batchWorkflow = workflows.get('batch-analysis');
    if (batchWorkflow) {
      const names = new Set<string>();
      for (const step of batchWorkflow.steps) {
        if (step.phase === 'batch' || step.phase === 'initialization') {
          names.add(step.name);
          if (step.substeps) {
            step.substeps.forEach(sub => names.add(sub));
          }
        }
      }
      return names;
    }
  } catch {
    // Fall back to empty set if YAML loading fails
  }
  return new Set();
}
// Lazy-initialize once
let _batchSteps: Set<string> | null = null;
function BATCH_STEPS(): Set<string> {
  if (!_batchSteps) _batchSteps = getBatchStepNames();
  return _batchSteps;
}

interface WorkflowConfig {
  workflowId: string;
  workflowName: string;
  repositoryPath: string;
  parameters: Record<string, any>;
  progressFile: string;
  pidFile: string;
}


/**
 * Update step timing statistics after workflow completion
 * This enables learned progress estimation for future runs
 */
async function updateTimingStatistics(
  repositoryPath: string,
  workflowName: string,
  totalBatches: number
): Promise<void> {
  try {
    const progressPath = path.join(repositoryPath, '.data/workflow-progress.json');
    if (!fs.existsSync(progressPath)) {
      log('[WorkflowRunner] Progress file not found for statistics update', 'warning');
      return;
    }

    const progressData = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
    const stepsDetail = progressData.stepsDetail || [];

    // Calculate batch phase duration (sum of batch step durations)
    let batchDurationMs = 0;
    let finalizationDurationMs = 0;
    const stepDurations: Record<string, number> = {};

    for (const step of stepsDetail) {
      const duration = step.duration || 0;
      stepDurations[step.name] = duration;

      if (BATCH_STEPS().has(step.name)) {
        batchDurationMs += duration;
      } else {
        finalizationDurationMs += duration;
      }
    }

    // Also process batch iterations if available
    const batchIterations = progressData.batchIterations || [];
    if (batchIterations.length > 0) {
      // Sum up all batch iteration durations
      batchDurationMs = 0;
      for (const batch of batchIterations) {
        for (const step of batch.steps || []) {
          batchDurationMs += step.duration || 0;
        }
      }
    }

    // Call the statistics update API
    const apiUrl = 'http://localhost:3033/api/workflows/statistics/update';
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflowName,
        batchDurationMs,
        finalizationDurationMs,
        totalBatches: totalBatches || batchIterations.length || 1,
        stepDurations
      })
    });

    if (response.ok) {
      const result = await response.json();
      log('[WorkflowRunner] Timing statistics updated', 'info', {
        sampleCount: result.data?.sampleCount,
        avgBatchDurationMs: result.data?.avgBatchDurationMs
      });
    } else {
      log('[WorkflowRunner] Failed to update timing statistics', 'warning', {
        status: response.status
      });
    }
  } catch (error) {
    // Non-fatal error - statistics update failure shouldn't break workflow completion
    log('[WorkflowRunner] Error updating timing statistics', 'warning', error);
  }
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

  // Register progress file subscriber -- writes WorkflowState to disk on every transition
  const unsubscribeProgressFile = subscribe(createProgressFileSubscriber(progressFile));

  // Read debug settings from progress file if they were pre-set by tools.ts.
  // Hoisted out of the try below: the wave-analysis branch forwards the same
  // resolved config to run-wave-analysis, so `ukb debug` keeps its behaviour
  // on both paths.
  let presetConfig: Record<string, any> = {};
  if (fs.existsSync(progressFile)) {
    try {
      presetConfig = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
    } catch { /* ignore */ }
  }

  // Dispatch start event to the runner's state machine instance
  try {
    dispatch({
      type: 'start',
      config: {
        singleStepMode: presetConfig.singleStepMode || parameters?.singleStepMode || false,
        mockLLM: presetConfig.mockLLM || parameters?.mockLLM || false,
        llmMode: presetConfig.llmState?.globalMode || parameters?.llmMode || 'public',
        stepIntoSubsteps: presetConfig.stepIntoSubsteps || parameters?.stepIntoSubsteps || false,
      },
      workflowName,
      firstStep: workflowName === 'wave-analysis' ? 'wave1_init' : 'initializing',
    });
  } catch (err) {
    // Reset and retry if state machine is in unexpected state (e.g., leftover from previous crash)
    if (err instanceof InvalidTransitionError) {
      log(`[WorkflowRunner] State machine in unexpected state, resetting: ${err.message}`, 'warning');
      reset();
      dispatch({
        type: 'start',
        config: {
          singleStepMode: parameters?.singleStepMode || false,
          mockLLM: parameters?.mockLLM || false,
          llmMode: parameters?.llmMode || 'public',
          stepIntoSubsteps: parameters?.stepIntoSubsteps || false,
        },
        workflowName,
        firstStep: workflowName === 'wave-analysis' ? 'wave1_init' : 'initializing',
      });
    } else {
      throw err;
    }
  }

  // Wave-analysis routing -- separate from coordinator path.
  //
  // The run itself lives in run-wave-analysis.ts because obs-api runs the same
  // workflow in-process (km-core's LevelDB is single-owner, so a run spawned
  // out here cannot open it while obs-api holds the lock). This path keeps
  // working wherever nothing else owns the store — it just passes no kmStore,
  // so WaveController opens a private one exactly as before.
  if (workflowName === 'wave-analysis') {
    const { runWaveAnalysis } = await import('./run-wave-analysis.js');

    // run-wave-analysis owns the state machine and the terminal write, so the
    // runner's own progress subscriber must stand down first or the two would
    // both write the terminal state.
    unsubscribeProgressFile();

    const result = await runWaveAnalysis({
      repositoryPath,
      team: parameters?.team || 'coding',
      progressFile,
      // Carry the debug config the runner already resolved, so `ukb debug`
      // still single-steps and mocks on this path.
      config: {
        singleStepMode: presetConfig.singleStepMode || parameters?.singleStepMode || false,
        mockLLM: presetConfig.mockLLM || parameters?.mockLLM || false,
        llmMode: presetConfig.llmState?.globalMode || parameters?.llmMode || 'public',
        stepIntoSubsteps: presetConfig.stepIntoSubsteps || parameters?.stepIntoSubsteps || false,
      },
    });

    try { fs.unlinkSync(pidFile); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(configPath); } catch (e) { /* ignore */ }
    process.exit(result.success ? 0 : 1);
  }

  const coordinator = new CoordinatorAgent(repositoryPath);
  cleanupState.coordinator = coordinator;

  try {
    // Map workflow names
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
      }
    };

    const mapping = workflowMapping[workflowName];
    const resolvedWorkflowName = mapping?.target || workflowName;
    const resolvedParameters = mapping ? { ...mapping.defaults, ...parameters } : parameters;

    // Get workflow info
    const workflows = coordinator.getWorkflows();
    const workflow = workflows.find(w => w.name === resolvedWorkflowName);
    const isBatchWorkflow = workflow?.type === 'iterative' || resolvedWorkflowName === 'batch-analysis';

    // Heartbeat removed -- subscriber writes on every transition, and coordinator
    // transitions serve as natural heartbeats. No separate interval needed.

    // Start watchdog timer to prevent indefinite hangs
    const MAX_WORKFLOW_DURATION_MS = loadWorkflowRunnerConfig().runner.max_duration_ms;
    const watchdogTimer = setTimeout(() => {
      log('[WorkflowRunner] Watchdog timeout - workflow exceeded max duration', 'error');
      gracefulCleanup(`Watchdog timeout: workflow exceeded ${MAX_WORKFLOW_DURATION_MS / 1000 / 60} minutes`, 1);
    }, MAX_WORKFLOW_DURATION_MS);
    cleanupState.watchdogTimer = watchdogTimer;

    // Execute the workflow
    log(`[WorkflowRunner] Executing ${resolvedWorkflowName} (batch: ${isBatchWorkflow})`, 'info');

    let execution;
    try {
      execution = isBatchWorkflow
        ? await coordinator.executeBatchWorkflow(resolvedWorkflowName, resolvedParameters)
        : await coordinator.executeWorkflow(resolvedWorkflowName, resolvedParameters);
    } finally {
      clearTimeout(watchdogTimer);
    }

    // Dispatch complete/fail event via state machine
    if (execution.status === 'completed') {
      try {
        dispatch({
          type: 'complete',
          summary: {
            steps: `${execution.currentStep}/${execution.totalSteps}`,
            message: `Workflow ${execution.status}`,
          },
        });
      } catch (err) {
        if (!(err instanceof InvalidTransitionError)) throw err;
      }
    } else {
      try {
        dispatch({
          type: 'fail',
          error: `Workflow ${execution.status}`,
          step: String(execution.currentStep),
        });
      } catch (err) {
        if (!(err instanceof InvalidTransitionError)) throw err;
      }
    }

    log(`[WorkflowRunner] Workflow completed: ${execution.status}`, 'info', {
      duration: `${Math.round((Date.now() - startTime.getTime()) / 1000)}s`,
      steps: `${execution.currentStep}/${execution.totalSteps}`
    });

    // Update timing statistics for learned progress estimation
    if (execution.status === 'completed') {
      const totalBatches = (execution as any).batchIterations?.length ||
                          parameters?.totalBatches || 1;
      await updateTimingStatistics(repositoryPath, resolvedWorkflowName, totalBatches);
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Dispatch fail event via state machine
    try {
      dispatch({ type: 'fail', error: errorMessage, step: 'unknown' });
    } catch (err) {
      if (!(err instanceof InvalidTransitionError)) throw err;
    }

    log(`[WorkflowRunner] Workflow failed: ${errorMessage}`, 'error', error);
    process.exit(1);

  } finally {
    // Unsubscribe progress file subscriber to prevent leaks
    unsubscribeProgressFile();

    try {
      await coordinator.shutdown();
    } catch (e) {
      log('[WorkflowRunner] Error during shutdown', 'error', e);
    }

    // Clean up PID file
    try {
      fs.unlinkSync(pidFile);
    } catch (e) {
      // Ignore
    }

    // Clean up config file
    try {
      fs.unlinkSync(configPath);
    } catch (e) {
      // Ignore
    }
  }
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
