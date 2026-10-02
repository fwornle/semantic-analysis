/**
 * The debug/mock configuration a workflow run starts with, and the one place it
 * is written onto the progress file.
 *
 * ── Why the file and not just the `start` event ───────────────────────────
 * createProgressFileSubscriber() merges the state machine's state with the file
 * already on disk, and for the debug fields (singleStepMode, stepIntoSubsteps,
 * mockLLM, llmState) the FILE wins — that is how the dashboard can toggle them
 * mid-run. The consequence is that a `start` event cannot set them: whatever
 * the previous run left behind is carried forward. tools.ts used to work around
 * that by writing the file before spawning the runner, but a run handed to
 * obs-api must not touch the shared file until obs-api has accepted it, or a
 * refused request would rewrite the settings of the run it was refused for.
 *
 * So the run writes its own config, at the moment it owns the file. Every field
 * is written explicitly — including `false` — because leaving a field out lets
 * a stale `mockLLM: true` from an earlier `ukb debug` turn a production run
 * into a mock one.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface RunConfig {
  singleStepMode?: boolean;
  mockLLM?: boolean;
  /** Milliseconds a mocked LLM call waits; only meaningful with mockLLM. */
  mockLLMDelay?: number;
  llmMode?: 'mock' | 'local' | 'public';
  stepIntoSubsteps?: boolean;
}

/** Write a run's debug/mock fields onto the progress file. Never throws. */
export function writeRunConfig(progressFile: string, config: RunConfig = {}): void {
  try {
    let existing: Record<string, any> = {};
    try {
      existing = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
    } catch {
      // Missing or unparseable — start from nothing.
    }

    const now = new Date().toISOString();
    const mockLLM = !!config.mockLLM;
    const next: Record<string, any> = {
      ...existing,
      singleStepMode: !!config.singleStepMode,
      stepIntoSubsteps: !!config.stepIntoSubsteps,
      stepPaused: false,
      pausedAtStep: null,
      singleStepUpdatedAt: now,
      mockLLM,
      mockLLMUpdatedAt: now,
      llmState: {
        globalMode: mockLLM ? 'mock' : (config.llmMode ?? 'public'),
        // Per-agent overrides are a dashboard setting, not a run setting.
        perAgentOverrides: existing.llmState?.perAgentOverrides || {},
        updatedAt: now,
      },
    };
    if (mockLLM) next.mockLLMDelay = config.mockLLMDelay ?? existing.mockLLMDelay ?? 500;

    fs.mkdirSync(path.dirname(progressFile), { recursive: true });
    fs.writeFileSync(progressFile, JSON.stringify(next, null, 2));
  } catch {
    // Best-effort: a run must not fail because its debug flags could not be
    // written. The start event still carries them.
  }
}
