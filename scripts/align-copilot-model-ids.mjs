#!/usr/bin/env node
/**
 * Align the vendored @rapid/llm-proxy copilot provider's model ids with the
 * ids Copilot actually serves.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The SDK pins its copilot tiers in a constructor default:
 *
 *     fast: 'claude-haiku-4.5', standard: 'claude-sonnet-4.6',
 *     premium: 'claude-opus-4.6', defaultModel: 'claude-sonnet-4.6'
 *
 * `claude-sonnet-4.6` and `claude-opus-4.6` were retired. Copilot answers a
 * request naming either with a hard 400:
 *
 *     The requested model is not available for integrator "opencode".
 *     Available models: [... claude-sonnet-5 claude-opus-5 ...]
 *
 * `standard` is the tier `semantic_analysis` maps to, so on 2026-09-20 EVERY
 * Wave 3 SemanticAnalysisAgent call 400'd on copilot, fell through to
 * claude-code (absent in the container, 60s timeout on the host) and surfaced
 * as `[llm] All providers failed`. The entity then took the shallow-analysis
 * path: six of that run's batch nodes landed as ~600-char stubs against ~4400
 * for a healthy one. Nothing in the log said "wrong model id".
 *
 * ── Why a script and not patch-package ─────────────────────────────────────
 * The dependency is a GitHub RELEASE TARBALL, not an npm package. patch-package
 * rebuilds its baseline by installing the name from the registry, which is a
 * different build — it produced a 148KB "patch" spanning 25 unrelated files
 * (network-detect, provider-registry, types, proxy-bridge/server.mjs, README).
 * Applying that would quietly roll the package back to the registry version.
 * There is no clean baseline to diff against, so the fix is expressed directly.
 *
 * ── Why it runs from TWO places ────────────────────────────────────────────
 * The container's `npm install` uses `--ignore-scripts` (deliberately — see the
 * Dockerfile), so a `postinstall` hook alone would fix the host and silently
 * miss the container, which is where wave-analysis actually runs. The Dockerfile
 * calls this script explicitly for that reason; `postinstall` covers host
 * installs. Idempotent, so running it twice is a no-op.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..', 'node_modules', '@rapid', 'llm-proxy');

/**
 * Retired id -> the successor Copilot actually serves. Keyed on the exact
 * quoted literal so a substring of a longer id can never be rewritten.
 */
const REPLACEMENTS = [
  ["'claude-sonnet-4.6'", "'claude-sonnet-5'"],
  ["'claude-opus-4.6'", "'claude-opus-5'"],
];

// Both the shipped source and the compiled output: dist/ is what Node loads,
// src/ is what anyone reads when they go looking for the value.
const TARGETS = [
  join(pkgRoot, 'src', 'providers', 'copilot-provider.ts'),
  join(pkgRoot, 'dist', 'providers', 'copilot-provider.js'),
];

if (!existsSync(pkgRoot)) {
  // Not an error: the package legitimately may not be installed yet (or at
  // all, in a slimmed install). Exit 0 so this never breaks an install.
  console.warn('[align-copilot-model-ids] @rapid/llm-proxy not installed — nothing to do');
  process.exit(0);
}

let changed = 0;
let missing = 0;
let stale = 0;

for (const file of TARGETS) {
  if (!existsSync(file)) {
    console.warn(`[align-copilot-model-ids] missing (package layout changed?): ${file}`);
    missing++;
    continue;
  }

  const before = readFileSync(file, 'utf8');
  let after = before;
  for (const [dead, live] of REPLACEMENTS) {
    after = after.split(dead).join(live);
  }

  if (after !== before) {
    writeFileSync(file, after);
    console.info(`[align-copilot-model-ids] rewrote retired ids in ${file}`);
    changed++;
  }

  // Verify rather than trust: if a retired id survives the rewrite, the file
  // shape changed in a way this script no longer understands. Say so loudly —
  // a silent miss here costs a whole wave of shallow entities.
  for (const [dead] of REPLACEMENTS) {
    if (readFileSync(file, 'utf8').includes(dead)) {
      console.error(`[align-copilot-model-ids] FAILED: ${dead} still present in ${file}`);
      stale++;
    }
  }
}

if (stale > 0) {
  process.exit(1);
}

if (missing === TARGETS.length) {
  console.warn('[align-copilot-model-ids] no target files found — package layout changed');
  process.exit(0);
}

console.info(
  changed > 0
    ? `[align-copilot-model-ids] done — ${changed} file(s) corrected`
    : '[align-copilot-model-ids] already aligned — no change needed',
);
