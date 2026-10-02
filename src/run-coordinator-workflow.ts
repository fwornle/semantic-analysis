/**
 * One implementation of "run a CoordinatorAgent workflow to completion" —
 * batch-analysis, incremental-analysis and complete-analysis — shared by the
 * two callers that need it.
 *
 * ── Why this module exists ─────────────────────────────────────────────────
 * Same reason as run-wave-analysis.ts, one step later. km-core's LevelDB is
 * single-owner-rw and obs-api holds it for the life of that process. Once
 * CoordinatorAgent was pointed at the canonical store (it used to address
 * `.data/knowledge-graph-migrated/`, which exists nowhere), a workflow-runner
 * child spawned by tools.ts could no longer open it — so these three workflows
 * go to obs-api over HTTP and run there on its open store.
 *
 * obs-api calls this with its store; workflow-runner calls it without one
 * (a private store, which still works wherever nothing else holds the lock).
 * Keeping both on one function is the point: a second copy is how the two
 * paths would drift apart again.
 */

import * as fs from 'fs';

import { CoordinatorAgent } from './agents/coordinator.js';
import { log } from './logging.js';
import { loadAllWorkflows, getConfigDir, loadWorkflowRunnerConfig } from './utils/workflow-loader.js';
import {
  dispatch,
  getState,
  reset,
  subscribe,
  createProgressFileSubscriber,
  InvalidTransitionError,
} from './workflow-state-machine.js';
import { writeTerminalState } from './workflow-runner-terminal-write.js';
import { writeRunConfig, type RunConfig } from './run-config.js';

/**
 * The public workflow names and what each runs. All three are batch-analysis
 * with different defaults; the names are what callers (and obs-api's routes)
 * use.
 */
export const COORDINATOR_WORKFLOWS: Record<string, { target: string; defaults: Record<string, any> }> = {
  'complete-analysis': {
    target: 'batch-analysis',
    // fullAnalysis: process ALL commits; forceCleanStart: clear old checkpoints
    // resumeFromCheckpoint: resume if crashes mid-run (new checkpoints created per batch)
    defaults: { fullAnalysis: true, forceCleanStart: true, resumeFromCheckpoint: true },
  },
  'incremental-analysis': {
    target: 'batch-analysis',
    // Fresh start each time - incremental means "since last analysis timestamp", not "resume crashed workflow"
    defaults: { fullAnalysis: false, forceCleanStart: true, resumeFromCheckpoint: true },
  },
  'batch-analysis': {
    target: 'batch-analysis',
    // Fresh start by default - use complete-analysis for crash recovery behavior
    defaults: { forceCleanStart: true, resumeFromCheckpoint: true },
  },
};

export interface RunCoordinatorWorkflowOptions {
  /** Absolute path to the repository being analyzed. Overrides any path in `parameters`. */
  repositoryPath: string;
  /** Public workflow name, e.g. 'incremental-analysis'. */
  workflowName: string;
  /** Tenant for writes. Omit to let CoordinatorAgent resolve it (strictly). */
  team?: string;
  /** Caller parameters, merged over the workflow's defaults. */
  parameters?: Record<string, any>;
  /** Absolute path to workflow-progress.json. */
  progressFile: string;
  /** An already-open km-core store owned by the caller; omit for a private one. */
  kmStore?: object;
  /** Debug/mock configuration the run starts with. Defaults to production. */
  config?: RunConfig;
  /** Receives the coordinator once constructed, e.g. for a signal handler. */
  onCoordinator?: (coordinator: CoordinatorAgent) => void;
  /**
   * Called when the run exceeds the configured max duration, after the run has
   * been marked failed. workflow-runner exits its process here. Without it the
   * coordinator is shut down and this function still waits for the execution
   * to settle — a host must not start another run on a store a runaway one is
   * still writing to.
   */
  onTimeout?: (reason: string) => void;
}

export interface RunCoordinatorWorkflowResult {
  success: boolean;
  /** The execution's own status, e.g. 'completed' or 'failed'. */
  status: string;
  /** `current/total` steps, when the run got far enough to report them. */
  steps?: string;
  /** Present when the run threw or timed out. */
  error?: string;
}

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

/**
 * Update step timing statistics after workflow completion
 * This enables learned progress estimation for future runs
 */
async function updateTimingStatistics(
  progressFile: string,
  workflowName: string,
  totalBatches: number
): Promise<void> {
  try {
    if (!fs.existsSync(progressFile)) {
      log('[CoordinatorRun] Progress file not found for statistics update', 'warning');
      return;
    }

    const progressData = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
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
      log('[CoordinatorRun] Timing statistics updated', 'info', {
        sampleCount: result.data?.sampleCount,
        avgBatchDurationMs: result.data?.avgBatchDurationMs
      });
    } else {
      log('[CoordinatorRun] Failed to update timing statistics', 'warning', {
        status: response.status
      });
    }
  } catch (error) {
    // Non-fatal error - statistics update failure shouldn't break workflow completion
    log('[CoordinatorRun] Error updating timing statistics', 'warning', error);
  }
}

function tryDispatch(event: Parameters<typeof dispatch>[0]): void {
  try {
    dispatch(event);
  } catch (err) {
    if (!(err instanceof InvalidTransitionError)) throw err;
  }
}

/**
 * Execute a coordinator workflow and leave the progress file in a terminal state.
 *
 * Never throws and never calls process.exit: obs-api is a long-lived server and
 * must survive a failed run. A thrown error is caught, written to the progress
 * file as the terminal failure, and returned as `{ success: false, error }`.
 */
export async function runCoordinatorWorkflow(
  opts: RunCoordinatorWorkflowOptions,
): Promise<RunCoordinatorWorkflowResult> {
  const { repositoryPath, workflowName, progressFile } = opts;

  const mapping = COORDINATOR_WORKFLOWS[workflowName];
  const resolvedWorkflowName = mapping?.target || workflowName;
  // The run's own repository wins over any path the caller sent: a request
  // relayed from the container carries `/coding`, which on the host names
  // nothing, and the coordinator prefers parameters.repositoryPath over its own.
  const { repository_path: _ignored, ...callerParameters } = opts.parameters ?? {};
  const resolvedParameters: Record<string, any> = {
    ...(mapping?.defaults ?? {}),
    ...callerParameters,
    repositoryPath,
  };

  // The state machine is module-level singleton state. In a long-lived host
  // that is only safe because runs are serialised by the caller's lock;
  // reset() clears whatever the previous run left behind.
  reset();
  // Before subscribing: the subscriber lets the file's debug fields win.
  writeRunConfig(progressFile, opts.config);
  const unsubscribe = subscribe(createProgressFileSubscriber(progressFile));

  tryDispatch({
    type: 'start',
    config: {
      singleStepMode: opts.config?.singleStepMode ?? false,
      mockLLM: opts.config?.mockLLM ?? false,
      llmMode: opts.config?.mockLLM ? 'mock' : (opts.config?.llmMode ?? 'public'),
      stepIntoSubsteps: opts.config?.stepIntoSubsteps ?? false,
    },
    workflowName,
    firstStep: 'initializing',
  });

  let coordinator: CoordinatorAgent | null = null;
  let timedOut: string | null = null;
  let watchdogTimer: NodeJS.Timeout | null = null;

  try {
    coordinator = new CoordinatorAgent(repositoryPath, opts.team, { kmStore: opts.kmStore });
    opts.onCoordinator?.(coordinator);

    const workflow = coordinator.getWorkflows().find(w => w.name === resolvedWorkflowName);
    const isBatchWorkflow = workflow?.type === 'iterative' || resolvedWorkflowName === 'batch-analysis';

    // Watchdog to prevent indefinite hangs
    const maxDurationMs = loadWorkflowRunnerConfig().runner.max_duration_ms;
    const activeCoordinator = coordinator;
    watchdogTimer = setTimeout(() => {
      timedOut = `Watchdog timeout: workflow exceeded ${maxDurationMs / 1000 / 60} minutes`;
      log(`[CoordinatorRun] ${timedOut}`, 'error');
      tryDispatch({ type: 'fail', error: timedOut, step: 'watchdog' });
      if (opts.onTimeout) {
        opts.onTimeout(timedOut);
      } else {
        activeCoordinator.shutdown().catch((e) => log('[CoordinatorRun] shutdown after timeout failed', 'error', e));
      }
    }, maxDurationMs);

    log(`[CoordinatorRun] Executing ${resolvedWorkflowName} as ${workflowName} (batch: ${isBatchWorkflow})`, 'info');

    const execution = isBatchWorkflow
      ? await coordinator.executeBatchWorkflow(resolvedWorkflowName, resolvedParameters)
      : await coordinator.executeWorkflow(resolvedWorkflowName, resolvedParameters);
    clearTimeout(watchdogTimer);

    if (timedOut) {
      unsubscribe();
      writeTerminalState(progressFile, 'failed', undefined, { error: timedOut, step: 'watchdog' });
      return { success: false, status: 'timeout', error: timedOut };
    }

    const steps = `${execution.currentStep}/${execution.totalSteps}`;

    // Cancelled from outside (obs-api's /api/workflows/cancel): keep the
    // terminal 'cancelled' rather than dispatching a fail over it.
    if (getState().status === 'cancelled' || execution.status === 'cancelled') {
      unsubscribe();
      writeTerminalState(progressFile, 'cancelled');
      return { success: false, status: 'cancelled', steps, error: 'cancelled' };
    }
    if (execution.status === 'completed') {
      tryDispatch({ type: 'complete', summary: { steps, message: `Workflow ${execution.status}` } });
    } else {
      tryDispatch({ type: 'fail', error: `Workflow ${execution.status}`, step: String(execution.currentStep) });
    }

    log(`[CoordinatorRun] Workflow completed: ${execution.status}`, 'info', { steps });

    // Reads stepsDetail from the progress file, so it must run while the
    // subscriber's full write is still what is on disk.
    if (execution.status === 'completed') {
      const totalBatches = (execution as any).batchIterations?.length ||
                          resolvedParameters.totalBatches || 1;
      await updateTimingStatistics(progressFile, resolvedWorkflowName, totalBatches);
    }

    return { success: execution.status === 'completed', status: execution.status, steps };
  } catch (error) {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    const message = error instanceof Error ? error.message : String(error);
    log(`[CoordinatorRun] Workflow failed: ${message}`, 'error', error);

    tryDispatch({ type: 'fail', error: message, step: 'unknown' });
    // The dispatch may have been an invalid transition and left 'running' on
    // disk; force the terminal state with no subscriber left to overwrite it.
    unsubscribe();
    writeTerminalState(progressFile, 'failed', undefined, { error: message, step: 'unknown' });

    return { success: false, status: 'failed', error: message };
  } finally {
    unsubscribe();
    if (coordinator) {
      try {
        await coordinator.shutdown();
      } catch (e) {
        log('[CoordinatorRun] Error during shutdown', 'error', e);
      }
    }
  }
}

/** True when `name` is one of the workflows this module runs. */
export function isCoordinatorWorkflow(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(COORDINATOR_WORKFLOWS, name);
}
