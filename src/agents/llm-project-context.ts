/**
 * Which project the LLM calls made inside a workflow run are spent on.
 *
 * The proxy attributes token usage to a project from `body.project` on
 * `/api/complete` (per-repo tenancy T4b). A workflow knows its project once —
 * the team/repo it analyses — but its calls are made from dozens of agents,
 * many layers down. Threading a parameter through all of them would be a
 * rewrite; a module-level default would be wrong, because the process that
 * runs workflows (obs-api) concurrently makes calls for OTHER projects (the
 * consolidator). AsyncLocalStorage scopes the project to the run's own async
 * call tree: `withLlmProject('coding', () => runWaveAnalysis(...))`.
 *
 * Read by llm-with-process.ts. An explicit `request.project` wins.
 *
 * @module agents/llm-project-context
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<string>();

/** Run `fn` with every LLM call in its async call tree attributed to `project`. */
export function withLlmProject<T>(project: string | null | undefined, fn: () => T): T {
  const id = typeof project === 'string' ? project.trim() : '';
  return id ? store.run(id, fn) : fn();
}

/** The project of the current async context, or undefined outside a run. */
export function currentLlmProject(): string | undefined {
  return store.getStore();
}
