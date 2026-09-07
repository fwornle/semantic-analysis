/**
 * One implementation of "run a wave-analysis to completion", shared by the two
 * callers that need it.
 *
 * ── Why this module exists ─────────────────────────────────────────────────
 * km-core's LevelDB is single-owner-rw. obs-api
 * (scripts/observations-api-server.mjs) opens it at startup and holds it for
 * the life of the process — that is the documented design, and the standalone
 * LSL-resolver job was already retired in favour of running in-process there
 * for exactly this reason.
 *
 * workflow-runner.ts never got the same treatment. It is spawned as a separate
 * process and opened its own GraphKMStore, so from the Plan 44-12 cutover
 * (2026-06-04) onward every wave-analysis run died one second in with
 * "Database failed to open". The failures are visible in .data/workflow-exit.log:
 * exit 1 on 2026-07-01, twice on 2026-08-27, and again on 2026-09-07. The last
 * green run, 2026-06-10, was the one that happened to start while nothing else
 * held the lock.
 *
 * The fix is to run the workflow inside the owner. This module is the seam:
 * obs-api calls it with its own open store, and workflow-runner calls it
 * without one (unchanged behaviour — a private store, which still works
 * wherever nothing else holds the lock, such as a fresh checkout or CI).
 * Keeping both on one function is the point: a second copy is how the two
 * paths would drift apart again.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  dispatch,
  reset,
  subscribe,
  createProgressFileSubscriber,
  InvalidTransitionError,
} from './workflow-state-machine.js';
import { writeTerminalState } from './workflow-runner-terminal-write.js';

export interface RunWaveAnalysisOptions {
  /** Absolute path to the repository being analyzed. */
  repositoryPath: string;
  /** Team name for knowledge-graph storage. */
  team: string;
  /** Absolute path to workflow-progress.json. */
  progressFile: string;
  /**
   * An already-open km-core store owned by the caller. Supply this when
   * running inside the owner process; omit it to let WaveController open a
   * private store.
   */
  kmStore?: object;
  /**
   * Debug/mock configuration for the run's state-machine `start` event.
   *
   * Defaults to a production run. workflow-runner passes what it resolved from
   * the progress file so `ukb debug` keeps working; obs-api omits it, because
   * an HTTP-triggered run is always a production one.
   */
  config?: {
    singleStepMode?: boolean;
    mockLLM?: boolean;
    llmMode?: 'mock' | 'local' | 'public';
    stepIntoSubsteps?: boolean;
  };
  /** Optional line logger; defaults to stderr. */
  logLine?: (message: string) => void;
}

export interface RunWaveAnalysisResult {
  success: boolean;
  totalEntities: number;
  waves: number;
  /** Present when the run threw rather than completing with errors. */
  error?: string;
}

/**
 * Read the progress file while it is still complete.
 *
 * This MUST happen before writeTerminalState(): the terminal write rebuilds
 * the file from a field allowlist that does NOT include `stepsDetail`, so a
 * snapshot taken afterwards records a run with no steps in it. That ordering
 * bug is why trace files carry aggregate zeroes.
 */
function readProgressSnapshot(progressFile: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Save a completed run's trace data to .data/trace-history/ for historical
 * comparison, keeping only the last 10 files.
 *
 * Lives here rather than in workflow-runner because both callers need it:
 * the runner used to own it, so the obs-api path wrote a workflow report but
 * no trace and the dashboard's History tab stayed empty for in-process runs.
 *
 * Never throws — trace history must not fail the workflow.
 */
export function saveTraceHistory(
  repositoryPath: string,
  progressData: Record<string, unknown> | null,
  workflowName: string,
  logLine: (message: string) => void,
  /**
   * Terminal status to record. The snapshot is taken before the terminal
   * write (that is the only moment stepsDetail still exists), so its own
   * `status` field still reads 'running' — recording that would label every
   * completed run as unfinished in the History tab.
   */
  terminalStatus: string = 'completed',
): void {
  try {
    if (!progressData) return;

    const stepsDetail = (progressData.stepsDetail as Array<Record<string, never>> | undefined) || [];

    // Aggregate totals from stepsDetail
    let totalLLMCalls = 0;
    let totalTokens = 0;
    const entityCounts: Record<string, number> = {};

    for (const step of stepsDetail as unknown as Array<Record<string, unknown>>) {
      if (step.llmCalls) totalLLMCalls += step.llmCalls as number;
      if (step.tokensUsed) totalTokens += step.tokensUsed as number;
      // Aggregate LLM calls from llmCallEvents if present
      if (Array.isArray(step.llmCallEvents)) {
        totalLLMCalls += step.llmCallEvents.length;
        for (const call of step.llmCallEvents as Array<Record<string, number>>) {
          totalTokens += (call.tokensIn || 0) + (call.tokensOut || 0);
        }
      }
      // Get entity counts from each step's entityFlow
      if (step.entityFlow) {
        const flow = step.entityFlow as Record<string, number>;
        entityCounts[step.name as string] = flow.persisted || flow.produced || 0;
      }
    }

    const traceData = {
      workflowName,
      startTime: progressData.startTime,
      endTime: progressData.lastUpdate,
      status: terminalStatus,
      totalLLMCalls,
      totalTokens,
      entityCounts,
      stepsDetail,
    };

    const traceDir = path.join(repositoryPath, '.data', 'trace-history');
    if (!fs.existsSync(traceDir)) {
      fs.mkdirSync(traceDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const traceFile = path.join(traceDir, `${timestamp}-${workflowName}.json`);
    fs.writeFileSync(traceFile, JSON.stringify(traceData, null, 2));
    logLine(`[run-wave-analysis] trace history saved: ${traceFile}`);

    // Cleanup: keep only the last 10 trace files (timestamp prefix sorts
    // alphabetically = chronologically).
    const files = fs.readdirSync(traceDir).filter((f) => f.endsWith('.json')).sort();
    if (files.length > 10) {
      for (const file of files.slice(0, files.length - 10)) {
        try {
          fs.unlinkSync(path.join(traceDir, file));
        } catch {
          // Ignore deletion errors
        }
      }
    }
  } catch (e) {
    logLine(
      `[run-wave-analysis] failed to save trace history (non-fatal): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

/**
 * Execute a wave-analysis run and leave the progress file in a terminal state.
 *
 * Never throws and never calls process.exit: obs-api is a long-lived server and
 * must survive a failed run. A thrown error is caught, written to the progress
 * file as the terminal failure, and returned as `{ success: false, error }`.
 */
export async function runWaveAnalysis(
  opts: RunWaveAnalysisOptions,
): Promise<RunWaveAnalysisResult> {
  const { repositoryPath, team, progressFile, kmStore } = opts;
  const logLine = opts.logLine ?? ((m: string) => process.stderr.write(`${m}\n`));

  // The state machine is module-level singleton state. In a long-lived host
  // that is only safe because runs are serialised by the caller's in-flight
  // guard; reset() clears whatever the previous run left behind (including a
  // terminal state that would make `start` an invalid transition).
  reset();

  const unsubscribe = subscribe(createProgressFileSubscriber(progressFile));

  try {
    dispatch({
      type: 'start',
      config: {
        singleStepMode: opts.config?.singleStepMode ?? false,
        mockLLM: opts.config?.mockLLM ?? false,
        llmMode: opts.config?.llmMode ?? 'public',
        stepIntoSubsteps: opts.config?.stepIntoSubsteps ?? false,
      },
      workflowName: 'wave-analysis',
      firstStep: 'wave1_init',
    });
  } catch (err) {
    if (!(err instanceof InvalidTransitionError)) {
      unsubscribe();
      throw err;
    }
    logLine(`[run-wave-analysis] ignoring invalid start transition: ${err.message}`);
  }

  try {
    const { WaveController } = await import('./agents/wave-controller.js');
    const controller = new WaveController({
      repositoryPath,
      team,
      progressFile,
      ...(kmStore ? { kmStore } : {}),
    });

    const result = await controller.execute();

    // Snapshot the progress file while stepsDetail is still on it — the
    // terminal write below drops everything outside its allowlist.
    const progressSnapshot = readProgressSnapshot(progressFile);

    const summary = {
      totalEntities: result.totalEntities,
      waves: result.waves.length,
      message:
        `Wave analysis completed: ${result.totalEntities} entities ` +
        `across ${result.waves.length} waves`,
    };

    try {
      dispatch(
        result.success
          ? { type: 'complete', summary }
          : { type: 'fail', error: 'Wave analysis completed with errors', step: 'wave-analysis' },
      );
    } catch (err) {
      if (!(err instanceof InvalidTransitionError)) throw err;
    }

    // Single-writer terminal guarantee (Phase 42 Plan 07 SC#4): the dispatch
    // above may have swallowed an InvalidTransitionError and left status
    // 'running' on disk. Unsubscribe FIRST so no late subscriber write lands
    // on top of ours, then force the terminal state synchronously.
    unsubscribe();
    if (result.success) {
      writeTerminalState(progressFile, 'completed', summary);
    } else {
      writeTerminalState(progressFile, 'failed', undefined, {
        error: 'Wave analysis completed with errors',
        step: 'wave-analysis',
      });
    }

    if (result.success) {
      saveTraceHistory(repositoryPath, progressSnapshot, 'wave-analysis', logLine, 'completed');
    }

    return { success: result.success, totalEntities: summary.totalEntities, waves: summary.waves };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logLine(`[run-wave-analysis] run threw: ${message}`);

    try {
      dispatch({ type: 'fail', error: message, step: 'wave-analysis' });
    } catch (err) {
      if (!(err instanceof InvalidTransitionError)) throw err;
    }

    unsubscribe();
    writeTerminalState(progressFile, 'failed', undefined, {
      error: message,
      step: 'wave-analysis',
    });

    return { success: false, totalEntities: 0, waves: 0, error: message };
  }
}

/** True when the progress file names a run that has not reached a terminal state. */
export function progressLooksRunning(progressFile: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
    return raw?.status === 'running';
  } catch {
    return false;
  }
}
