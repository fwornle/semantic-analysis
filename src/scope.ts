/**
 * Which tenant owns this installation's knowledge, as seen from
 * semantic-analysis.
 *
 * WHY A SECOND BRIDGE RATHER THAN A MEMBER OF data-paths.ts. The two resolvers
 * are one dependency graph on disk (`lib/paths/data-home.cjs` requires
 * `../scope/resolve.cjs`), but they are TWO separate read-only mounts in
 * `docker/docker-compose.yml:112-113`. A missing-`lib/scope` failure has to name
 * `lib/scope`, not `lib/paths`, or the operator goes looking in the wrong place.
 * Everything else here is `data-paths.ts`'s shape, deliberately.
 *
 * WHY THE FAIL-CLOSED PROBE IS `requireScope` AND NOT `resolveScope`. The
 * resolvers are bind-mounted, so they are versioned independently of this image:
 * a container can boot against a HOST `lib/scope` that predates strict
 * resolution. Probing the newer export turns that into a loud startup error
 * instead of a silently lenient tenancy decision.
 *
 * STRICT vs LENIENT — the rule:
 *
 *   Set the scope to `zzz`. Run the path. Does the literal `zzz` end up ON DISK
 *   INSIDE KNOWLEDGE — an entity's `metadata.team`, a node id, an export
 *   filename? Then use `requireScope()`. If it only filters, queries, displays
 *   or names machine-local churn, use `resolveScope()` and treat the placeholder
 *   as "no filter" via `isPlaceholderScope()`.
 *
 * NEVER call `requireScope()` at module top level or in a default-parameter
 * position. Both are eager, and a throw there makes a long-lived program
 * unstartable rather than making one write refuse.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { repositoryRoot } from './data-paths.js';

/** The subset of lib/scope this package uses. */
export interface ScopeResolver {
  DEFAULT_SCOPE: string;
  /** Lenient: yields the inert placeholder when nothing is configured. */
  resolveScope(): string;
  /** Strict: throws ScopeError when no real tenant is configured. */
  requireScope(): string;
  isPlaceholderScope(value: unknown): boolean;
  explain(): {
    scope: string;
    source: string;
    path: string | null;
    isDefault: boolean;
  };
}

let cached: ScopeResolver | null = null;

/**
 * Resolve the scope helper. Cached: the answer cannot change within a process.
 */
export async function scopeResolver(repositoryPath?: string): Promise<ScopeResolver> {
  if (cached) return cached;
  const root = repositoryRoot(repositoryPath);
  const href = pathToFileURL(path.join(root, 'lib', 'scope', 'index.mjs')).href;
  const mod = (await import(href)) as { default?: ScopeResolver } & Partial<ScopeResolver>;
  const impl = mod.default ?? (mod as ScopeResolver);
  if (typeof impl.requireScope !== 'function') {
    throw new Error(
      `scope: ${href} did not export the expected helper — ` +
        'is lib/scope mounted into the container, and is it recent enough to ' +
        'export requireScope?',
    );
  }
  cached = impl;
  return impl;
}

/** Test seam: drop the cached module so a suite can point at a different root. */
export function resetScopeCache(): void {
  cached = null;
}

/**
 * The tenant to WRITE onto an entity. Throws when none is configured.
 *
 * Convenience over `(await scopeResolver(root)).requireScope()`, which is the
 * shape every persisting call site would otherwise repeat.
 */
export async function requireTenant(repositoryPath?: string): Promise<string> {
  return (await scopeResolver(repositoryPath)).requireScope();
}

/**
 * The tenant to FILTER by, or `undefined` for "every tenant".
 *
 * `undefined` rather than the placeholder is the whole point: a query narrowed
 * to `team: 'default'` returns zero rows, and an empty knowledge base looks
 * exactly like one that lost its content.
 */
export async function tenantFilter(repositoryPath?: string): Promise<string | undefined> {
  const s = await scopeResolver(repositoryPath);
  const scope = s.resolveScope();
  return s.isPlaceholderScope(scope) ? undefined : scope;
}
