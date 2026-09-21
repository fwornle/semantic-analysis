/**
 * Tests for LSL discovery.
 *
 * The load-bearing test here is the last one. Every other case would have
 * passed against the broken flat-readdir implementation if it had been given a
 * flat fixture — which is precisely how the real bug survived: the code was
 * correct for a layout that no longer existed, and its failure mode was an
 * empty list rather than an error. `finds the real corpus` asserts against the
 * actual checkout, so it fails when the on-disk layout moves again.
 *
 * Test framework: node:test + node:assert/strict (matches sibling *.test.ts).
 * Run via: npm run build && node --test dist/utils/lsl-discovery.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  listLslFiles,
  parseLslFilenameStart,
  hasLslTranches,
  lslHistoryRoot,
} from './lsl-discovery.js';

function makeTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsl-discovery-'));
  const hist = path.join(root, '.specstory', 'history');
  fs.mkdirSync(path.join(hist, '2026', '09'), { recursive: true });
  fs.mkdirSync(path.join(hist, '2025', '11'), { recursive: true });
  fs.mkdirSync(path.join(hist, 'logs'), { recursive: true });

  fs.writeFileSync(path.join(hist, '2026', '09', '2026-09-21_1600-1700_c197ef.jsonl'), '{}');
  fs.writeFileSync(path.join(hist, '2026', '09', '2026-09-21_2300-0000_c197ef.jsonl'), '{}');
  fs.writeFileSync(path.join(hist, '2025', '11', '2025-11-15_1800-1900-7_g9b30a.md'), '#');
  // Neighbours that share the tree but are not sessions:
  fs.writeFileSync(path.join(hist, 'README.md'), '# not a session');
  fs.writeFileSync(path.join(hist, 'chain-map.json'), '{}');
  fs.writeFileSync(path.join(hist, 'logs', 'debug.md'), 'not a session either');
  return root;
}

test('parses the start instant from a canonical filename', () => {
  const d = parseLslFilenameStart('2026-09-21_1600-1700_c197ef.jsonl');
  assert.equal(d?.toISOString(), '2026-09-21T16:00:00.000Z');
});

test('the 2300-0000 tranche dates to its own day, not the next one', () => {
  // Reading the END of this window would roll over to the 22nd.
  const d = parseLslFilenameStart('2026-09-21_2300-0000_c197ef.jsonl');
  assert.equal(d?.toISOString(), '2026-09-21T23:00:00.000Z');
});

test('continuation suffixes are still sessions', () => {
  assert.ok(parseLslFilenameStart('2025-11-15_1800-1900-7_g9b30a.md'));
});

test('non-session names are rejected', () => {
  for (const n of ['README.md', 'chain-map.json', 'debug.md', 'notes-2026-09-21.md']) {
    assert.equal(parseLslFilenameStart(n), null, `${n} should not parse`);
  }
});

test('discovers files nested in YYYY/MM and ignores the neighbours', () => {
  const root = makeTree();
  const files = listLslFiles(lslHistoryRoot(root));
  assert.equal(files.length, 3);
  assert.ok(!files.some(f => f.name === 'README.md'));
  assert.ok(!files.some(f => f.name === 'debug.md'));
});

test('orders newest first by default and oldest on request', () => {
  const root = makeTree();
  const newest = listLslFiles(lslHistoryRoot(root));
  assert.equal(newest[0].name, '2026-09-21_2300-0000_c197ef.jsonl');
  assert.equal(newest[2].name, '2025-11-15_1800-1900-7_g9b30a.md');

  const oldest = listLslFiles(lslHistoryRoot(root), { order: 'oldest' });
  assert.equal(oldest[0].name, '2025-11-15_1800-1900-7_g9b30a.md');
});

test('honours since, until and max', () => {
  const root = makeTree();
  const hist = lslHistoryRoot(root);

  const since = listLslFiles(hist, { since: new Date('2026-01-01T00:00:00Z') });
  assert.equal(since.length, 2);

  const until = listLslFiles(hist, { until: new Date('2026-01-01T00:00:00Z') });
  assert.equal(until.length, 1);

  assert.equal(listLslFiles(hist, { max: 1 }).length, 1);
});

test('hasLslTranches tells an empty project apart from a broken scanner', () => {
  const root = makeTree();
  assert.equal(hasLslTranches(lslHistoryRoot(root)), true);

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'lsl-bare-'));
  fs.mkdirSync(path.join(bare, '.specstory', 'history'), { recursive: true });
  assert.equal(hasLslTranches(lslHistoryRoot(bare)), false);
});

test('finds the real corpus — fails if the on-disk layout moves again', () => {
  // Walk up to the checkout that owns .specstory/history.
  let dir = process.cwd();
  let found: string | null = null;
  while (dir && dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.specstory', 'history'))) { found = dir; break; }
    dir = path.dirname(dir);
  }
  if (!found) {
    // No checkout to assert against (fresh clone, CI without history) — the
    // synthetic cases above still cover the logic.
    return;
  }

  const hist = lslHistoryRoot(found);
  if (!hasLslTranches(hist)) return; // genuinely no sessions recorded yet

  const files = listLslFiles(hist);
  assert.ok(
    files.length > 0,
    `tranches exist under ${hist} but discovery returned 0 files — ` +
      'this is the exact condition that hid 20,000+ sessions from UKB'
  );
  // Newest-first ordering must hold on real data too.
  assert.ok(files[0].date >= files[files.length - 1].date);
});
