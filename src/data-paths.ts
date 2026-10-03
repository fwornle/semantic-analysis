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
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/**
 * Where the repo root is, for every consumer in this package.
 *
 * WHY THIS EXISTS. Four idioms disagreed, inside one package and sometimes
 * inside one process:
 *
 *   sse-server.ts    REPOSITORY_PATH || '/coding'          correct in-container
 *   tools.ts         REPOSITORY_PATH || process.cwd()      WRONG: in-container the
 *                                                          cwd is .../integrations/
 *                                                          semantic-analysis, which
 *                                                          put the LevelDB in the
 *                                                          container's writable
 *                                                          layer and pointed
 *                                                          ontologyDir at a
 *                                                          directory that does not
 *                                                          exist
 *   tools.ts         CODING_ROOT || repositoryPath
 *   wave-controller  constructor-injected
 *
 * And `REPOSITORY_PATH` is set by NOBODY anywhere in the repo — not compose, not
 * the Dockerfile, not a plist — so every one of those was running on its
 * fallback.
 *
 * The derived-from-module-location step is what makes the stdio-MCP entry points
 * (`server.ts`, `index.ts`) work on the HOST, where none of these variables is
 * set and `'/coding'` does not exist. From `dist/data-paths.js`, three levels up
 * is the package root's parent chain to the repo.
 */
export function repositoryRoot(explicit?: string): string {
  const fromEnv =
    process.env.REPOSITORY_PATH || process.env.CODING_ROOT || process.env.CODING_REPO;
  if (explicit && explicit.trim() && explicit.trim() !== '.') return explicit;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  try {
    // dist/data-paths.js → dist → semantic-analysis → integrations → repo root
    return fileURLToPath(new URL('../../../..', import.meta.url));
  } catch {
    return '/coding';
  }
}

let cached: DataPaths | null = null;

/**
 * Resolve the data-path helper. Cached: this is called on every store open and
 * the answer cannot change within a process.
 */
export async function dataPaths(repositoryPath?: string): Promise<DataPaths> {
  if (cached) return cached;
  const root = repositoryRoot(repositoryPath);
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

/**
 * The knowledge-export layout for a store in THIS process (coding
 * lib/kb/layout.mjs, mode 'local'): hydrate merges every project's export —
 * each repo's learning checkout, teammates' shared clones, the local files —
 * and writes stay in the data home's `exports/general.json`, as before. Only
 * obs-api (the 'owner') writes into repos; the container could not anyway,
 * /workspace is mounted read-only.
 *
 * Reading everything is the point: a store that never saw the owner's
 * tombstones would keep re-exporting what the owner deleted, and a UKB run
 * would not see what a teammate pushed.
 *
 * Returns undefined when the module is not there (lib/kb not mounted, an
 * older checkout): the store then uses km-core's default single-dir layout,
 * which is what it did before.
 */
export async function localKbLayout(repositoryPath?: string): Promise<unknown | undefined> {
  const root = repositoryRoot(repositoryPath);
  try {
    const href = pathToFileURL(path.join(root, 'lib', 'kb', 'layout.mjs')).href;
    const mod = (await import(href)) as { kbLayout?: (o: object) => unknown };
    return mod.kbLayout?.({ mode: 'local', codingRoot: root });
  } catch {
    return undefined;
  }
}
