/**
 * Regression contract for the batch-derived counters in the UKB progress
 * summary (`progress.summary.totalCommits` and friends).
 *
 * ── The bug ────────────────────────────────────────────────────────────────
 * `writeProgressFile` rebuilt `summary` on every write by summing the
 * `*Count` outputs over `stepsDetail`. For a batch workflow that is the wrong
 * source: `resetBatchPhaseSteps()` deletes the batch-phase entries from
 * `execution.results` at every batch boundary, and whatever survives is then
 * filtered by `batchId`. So `stepsDetail` never describes more than the batch
 * currently in flight, and:
 *
 *   - between the reset and the next `extract_batch_commits`, the summary read
 *     `totalCommits: 0` — a large part of every run;
 *   - mid-batch it read that one batch's commits, not the run total;
 *   - a field named `totalCommits` therefore never once reported a total.
 *
 * The fix aggregates over `execution.batchIterations` — the durable per-batch
 * record that survives the reset — and takes only NON-batch steps from
 * `stepsDetail`, so the in-flight batch is counted exactly once.
 *
 * Run via:
 *   npm run build && node --test dist/agents/coordinator-summary-aggregation.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateBatchDerivedCounts,
  type CountableStep,
  type CountableBatchIteration,
} from './coordinator.js';

// The batch-phase step names writeProgressFile passes in (`batchSpecificSteps`).
const BATCH_STEPS: ReadonlySet<string> = new Set([
  'extract_batch_commits',
  'extract_batch_sessions',
  'batch_semantic_analysis',
  'generate_batch_observations',
  'classify_with_ontology',
  'kg_operators',
  'batch_qa',
  'save_batch_checkpoint',
]);

function batch(
  batchId: string,
  counts: { commits?: number; files?: number; sessions?: number; observations?: number },
): CountableBatchIteration {
  const steps: CountableStep[] = [];
  if (counts.commits !== undefined || counts.files !== undefined) {
    steps.push({
      name: 'extract_batch_commits',
      outputs: { commitsCount: counts.commits ?? 0, filesCount: counts.files ?? 0 },
    });
  }
  if (counts.sessions !== undefined) {
    steps.push({ name: 'extract_batch_sessions', outputs: { sessionsCount: counts.sessions } });
  }
  if (counts.observations !== undefined) {
    steps.push({
      name: 'generate_batch_observations',
      outputs: { observationsCount: counts.observations },
    });
  }
  return { batchId, steps };
}

describe('aggregateBatchDerivedCounts — non-batch workflows are unchanged', () => {
  it('with no batch iterations it is the plain sum over stepsDetail', () => {
    const stepsDetail: CountableStep[] = [
      { name: 'git_history', outputs: { commitsCount: 12, filesCount: 40 } },
      { name: 'vibe_history', outputs: { sessionsCount: 7 } },
      { name: 'observation_gen', outputs: { observationsCount: 5 } },
    ];

    assert.deepEqual(aggregateBatchDerivedCounts(stepsDetail, undefined, BATCH_STEPS), {
      totalCommits: 12,
      totalFiles: 40,
      totalSessions: 7,
      totalObservations: 5,
    });
  });

  it('an empty batch-iteration array is treated as "not a batch run"', () => {
    const stepsDetail: CountableStep[] = [
      { name: 'extract_batch_commits', outputs: { commitsCount: 3 } },
    ];
    assert.equal(
      aggregateBatchDerivedCounts(stepsDetail, [], BATCH_STEPS).totalCommits,
      3,
    );
  });

  it('steps with no outputs contribute nothing and do not throw', () => {
    const stepsDetail: CountableStep[] = [
      { name: 'plan_batches' },
      { name: 'noop', outputs: null },
      { name: 'git_history', outputs: { commitsCount: 4 } },
    ];
    assert.equal(aggregateBatchDerivedCounts(stepsDetail, [], BATCH_STEPS).totalCommits, 4);
  });
});

describe('aggregateBatchDerivedCounts — the reported regression', () => {
  it('a freshly reset batch no longer reports 0 for work already done', () => {
    // resetBatchPhaseSteps() has just cleared the batch-phase results, so
    // stepsDetail carries nothing countable. Two batches are already done.
    const stepsDetail: CountableStep[] = [
      { name: 'plan_batches', outputs: { totalBatches: 32 } },
    ];
    const iterations = [
      batch('batch-001', { commits: 47, files: 120, sessions: 0, observations: 18 }),
      batch('batch-002', { commits: 29, files: 80, sessions: 4, observations: 11 }),
    ];

    assert.deepEqual(aggregateBatchDerivedCounts(stepsDetail, iterations, BATCH_STEPS), {
      totalCommits: 76,
      totalFiles: 200,
      totalSessions: 4,
      totalObservations: 29,
    });
  });

  it('the counter is a RUN total, not the current batch', () => {
    // Mid-batch-3: stepsDetail describes batch 3 only. The old code returned 39.
    const stepsDetail: CountableStep[] = [
      { name: 'extract_batch_commits', outputs: { commitsCount: 39, filesCount: 95 } },
    ];
    const iterations = [
      batch('batch-001', { commits: 47, files: 120 }),
      batch('batch-002', { commits: 29, files: 80 }),
      batch('batch-003', { commits: 39, files: 95 }),
    ];

    const totals = aggregateBatchDerivedCounts(stepsDetail, iterations, BATCH_STEPS);
    assert.equal(totals.totalCommits, 115);
    assert.equal(totals.totalFiles, 295);
  });

  it('the in-flight batch is counted once, not twice', () => {
    // The same batch appears in BOTH sources — batchIterations (durable) and
    // stepsDetail (current batch). Double counting here would inflate every
    // mid-batch reading.
    const stepsDetail: CountableStep[] = [
      { name: 'extract_batch_commits', outputs: { commitsCount: 47, filesCount: 120 } },
      { name: 'extract_batch_sessions', outputs: { sessionsCount: 9 } },
    ];
    const iterations = [batch('batch-001', { commits: 47, files: 120, sessions: 9 })];

    assert.deepEqual(aggregateBatchDerivedCounts(stepsDetail, iterations, BATCH_STEPS), {
      totalCommits: 47,
      totalFiles: 120,
      totalSessions: 9,
      totalObservations: 0,
    });
  });

  it('the finalization phase does not re-count the last batch', () => {
    // During finalization the batchId filter is deliberately bypassed so the
    // last batch's steps stay green in stepsDetail — they must still not be
    // added on top of their own batch iteration.
    const stepsDetail: CountableStep[] = [
      { name: 'extract_batch_commits', outputs: { commitsCount: 29, filesCount: 80 } },
      { name: 'generate_batch_observations', outputs: { observationsCount: 11 } },
      { name: 'generate_insights', outputs: { observationsCount: 6 } },
    ];
    const iterations = [
      batch('batch-001', { commits: 47, files: 120, observations: 18 }),
      batch('batch-002', { commits: 29, files: 80, observations: 11 }),
    ];

    const totals = aggregateBatchDerivedCounts(stepsDetail, iterations, BATCH_STEPS);
    assert.equal(totals.totalCommits, 76);
    // 18 + 11 from the batches, + 6 from the non-batch finalization step.
    assert.equal(totals.totalObservations, 35);
  });

  it('non-batch steps still contribute during a batch run', () => {
    const stepsDetail: CountableStep[] = [
      { name: 'code_graph', outputs: { filesCount: 500 } },
    ];
    const iterations = [batch('batch-001', { commits: 47, files: 120 })];

    assert.equal(aggregateBatchDerivedCounts(stepsDetail, iterations, BATCH_STEPS).totalFiles, 620);
  });
});

describe('aggregateBatchDerivedCounts — counting hygiene', () => {
  it('a step retried within one batch counts once (last wins)', () => {
    const iterations: CountableBatchIteration[] = [
      {
        batchId: 'batch-001',
        steps: [
          { name: 'generate_batch_observations', outputs: { observationsCount: 5 } },
          // QA rejected the first attempt; the retry replaces it.
          { name: 'generate_batch_observations', outputs: { observationsCount: 8 } },
        ],
      },
    ];
    assert.equal(
      aggregateBatchDerivedCounts([], iterations, BATCH_STEPS).totalObservations,
      8,
    );
  });

  it('the same step name in DIFFERENT batches is counted per batch', () => {
    const iterations = [
      batch('batch-001', { sessions: 3 }),
      batch('batch-002', { sessions: 4 }),
    ];
    assert.equal(aggregateBatchDerivedCounts([], iterations, BATCH_STEPS).totalSessions, 7);
  });

  it('an explicit 0 is a real count, not a missing one', () => {
    // Guards the old `if (outputs.sessionsCount)` truthiness test: a batch with
    // zero sessions must neither throw nor disturb the running total.
    const iterations = [
      batch('batch-001', { sessions: 0 }),
      batch('batch-002', { sessions: 6 }),
    ];
    assert.equal(aggregateBatchDerivedCounts([], iterations, BATCH_STEPS).totalSessions, 6);
  });

  it('non-numeric and non-finite outputs are ignored', () => {
    const iterations: CountableBatchIteration[] = [
      {
        batchId: 'batch-001',
        steps: [
          { name: 'extract_batch_commits', outputs: { commitsCount: '47' as unknown as number } },
          { name: 'extract_batch_sessions', outputs: { sessionsCount: NaN } },
        ],
      },
    ];
    assert.deepEqual(aggregateBatchDerivedCounts([], iterations, BATCH_STEPS), {
      totalCommits: 0,
      totalFiles: 0,
      totalSessions: 0,
      totalObservations: 0,
    });
  });

  it('a batch iteration with no steps is harmless', () => {
    const iterations: CountableBatchIteration[] = [
      { batchId: 'batch-001', steps: [] },
      batch('batch-002', { commits: 5 }),
    ];
    assert.equal(aggregateBatchDerivedCounts([], iterations, BATCH_STEPS).totalCommits, 5);
  });
});
