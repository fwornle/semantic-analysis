/**
 * Where this installation's data lives, as seen from semantic-analysis.
 *
 * WHY A BRIDGE RATHER THAN AN IMPORT. The resolver lives in the parent repo at
 * `lib/paths/`, outside this package. A compile-time import across that boundary
 * would drag a second package's files into this tsconfig's rootDir and into the
 * published `dist/` layout. So it is resolved at RUNTIME, from `REPOSITORY_PATH`
 * — the seam that already tells this package where the repo is — using the same
 * dynamic-import idiom `wave-controller.ts` already uses for `@fwornle/km-core`.
 *
 * WHY NOT JUST READ CODING_DATA_HOME AND JOIN PATHS HERE. Because then the
 * LAYOUT (`var/knowledge-graph/leveldb`, `kb/knowledge-graph/exports`, and which
 * side of the tracked/untracked line each falls on) would exist in two places.
 * The container is told its data ROOT via `CODING_DATA_HOME=/coding/data`, and
 * derives everything below it with the host's own code. One implementation.
 *
 * `docker/docker-compose.yml` mounts `lib/paths` and `lib/scope` read-only for
 * exactly this reason. A missing mount surfaces as a loud module-resolution
 * error at startup, which is the correct failure: the alternative is silently
 * opening an empty graph somewhere else.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The subset of lib/paths this package uses. */
export interface DataPaths {
  dataHome(): string;
  historyDir(): string;
  kbDir(): string;
  varDir(): string;
  /** Graph JSON exports — TRACKED. km-core hydrates from these. */
  graphExportsDir(): string;
  /** Generated puml/png per insight — TRACKED. */
  insightsDir(): string;
  /** Observation cold store — TRACKED. */
  observationExportDir(): string;
  /** Per-team JSON exports — TRACKED. */
  knowledgeExportDir(): string;
  /** The live LevelDB — NOT tracked; a projection of graphExportsDir(). */
  graphDbDir(): string;
  /** Create the root and its three subtrees, plus the var/ .gitignore. */
  ensureDataHome(): string;
  explain(): Record<string, unknown>;
}

let cached: DataPaths | null = null;

/**
 * Resolve the data-path helper. Cached: this is called on every store open and
 * the answer cannot change within a process.
 */
export async function dataPaths(repositoryPath?: string): Promise<DataPaths> {
  if (cached) return cached;
  const root = repositoryPath || process.env.REPOSITORY_PATH || '/coding';
  const href = pathToFileURL(path.join(root, 'lib', 'paths', 'index.mjs')).href;
  const mod = (await import(href)) as { default?: DataPaths } & Partial<DataPaths>;
  const impl = mod.default ?? (mod as DataPaths);
  if (typeof impl.graphDbDir !== 'function') {
    throw new Error(
      `data-paths: ${href} did not export the expected helper — ` +
        'is lib/paths mounted into the container?',
    );
  }
  cached = impl;
  return impl;
}

/** Test seam: drop the cached module so a suite can point at a different root. */
export function resetDataPathsCache(): void {
  cached = null;
}
