/**
 * The one place a GraphKMStore is opened outside sse-server.ts.
 *
 * WHY THIS EXISTS. Four call sites each constructed their own store. One
 * (`wave-controller.ts`) was right; three addressed
 * `.data/knowledge-graph-migrated/`, a directory that exists nowhere — so the
 * entity WRITER (`create_ukb_entity_with_insight`) wrote where nothing reads and
 * `refresh_entity` read what nothing wrote. Phase 42.2 Plan 05 collapsed that
 * directory into the canonical one and reverted wave-controller's path; the other
 * three were never updated.
 *
 * Repointing them is not enough on its own, for two reasons.
 *
 * 1. LevelDB IS SINGLE-OWNER-RW. `sse-server.ts:16` imports `handleToolCall`
 *    from `tools.js`, so those handlers run INSIDE the process that already
 *    holds the store open. A second `new GraphKMStore` on the same directory
 *    means two in-memory graphs over one database, each of which rewrites the
 *    whole graph when it closes. On the host, obs-api (port 12436) is the single
 *    owner for the life of that process.
 *
 * 2. `close()` IS NOT A NO-OP. `km-core-adapter.ts` used to say it was. It is
 *    not: `GraphKMStore.close()` exists, `persistOnClose` defaults to true, and
 *    it calls `persistGraph(graph.export())` and then closes the LevelDB handle.
 *    `handleCreateUkbEntity` already had `finally { await adapter.close() }`.
 *    Hand it a BORROWED store and every call would rewrite the entire graph and
 *    close sse-server's handle out from under it — while review reads the call as
 *    harmless, because the comment said so.
 *
 * So ownership is explicit here, and `release()` is the only sanctioned route to
 * `adapter.close()`. `tests/scope/phantom-store.test.mjs` enforces that.
 */

import path from 'node:path';
import { createKmCoreAdapter, type KmCoreAdapter } from './km-core-adapter.js';
import { dataPaths, localKbLayout, repositoryRoot } from '../data-paths.js';

/**
 * Returns the host's open store, or null while it is still hydrating.
 *
 * A FUNCTION rather than a store reference, matching the idiom already used by
 * `scripts/observations-api-server.mjs` (`kmStoreGetter: () => ...`): sse-server
 * constructs its store at module top level but opens it later, so a reference
 * registered at construction time would hand out a half-open store.
 */
type KmStoreProvider = () => object | null;

let provider: KmStoreProvider | null = null;

export function setKmStoreProvider(fn: KmStoreProvider): void {
  provider = fn;
}

/** Test seam, and the way an entry point opts out. */
export function clearKmStoreProvider(): void {
  provider = null;
}

export function hasKmStoreProvider(): boolean {
  return provider !== null;
}

/** Thrown when the host owns the store but has not finished opening it. */
export class KmStoreNotReadyError extends Error {
  constructor() {
    super(
      'the knowledge graph is still being opened by this process — retry in a ' +
        'moment. (Not falling back to a private store: that would be a second ' +
        'LevelDB handle on the same directory.)',
    );
    this.name = 'KmStoreNotReadyError';
  }
}

export interface AcquiredStore {
  store: object;
  adapter: KmCoreAdapter;
  /** False when the store was borrowed from the host and must not be closed. */
  owned: boolean;
  /** The ONLY sanctioned path to adapter.close(). A no-op when borrowed. */
  release(): Promise<void>;
}

export interface AcquireOptions {
  repositoryPath?: string;
  /** The tenant to tag writes with. Resolve it with requireTenant(). */
  team: string;
  /** A caller-owned open store, e.g. WaveControllerConfig.kmStore. */
  injected?: object;
}

/**
 * Get a store and an adapter, borrowing the host's when there is one.
 *
 * Three outcomes, which a nullable store reference could not express:
 *
 *   no provider registered       stdio-MCP (server.ts / index.ts), or a detached
 *                                child — open a private store
 *   provider returns a store     in sse-server, open — borrow it, never close it
 *   provider returns null        in sse-server, still hydrating — THROW
 *
 * That third row is the point. Falling back to opening a private store there is
 * exactly the double-open this module exists to prevent.
 */
export async function acquireKmStore(opts: AcquireOptions): Promise<AcquiredStore> {
  // An explicit injection wins over the module singleton: obs-api injects
  // through WaveControllerConfig.kmStore in a DIFFERENT process from the one
  // where this singleton lives, and both routes have to keep working.
  if (opts.injected) {
    return borrow(opts.injected, opts.team);
  }
  if (provider) {
    const hosted = provider();
    if (!hosted) throw new KmStoreNotReadyError();
    return borrow(hosted, opts.team);
  }

  const root = repositoryRoot(opts.repositoryPath);
  const DATA = await dataPaths(root);
  DATA.ensureDataHome();
  const dbPath = DATA.graphDbDir();

  const km = await import('@fwornle/km-core');
  const layout = (await localKbLayout(root)) as import('@fwornle/km-core').GraphKMStoreOptions['layout'];
  const store = new km.GraphKMStore({
    dbPath,
    exportDir: DATA.graphExportsDir(),
    layout,
    // The curated dir obs-api opens, so a standalone run and an in-process run
    // see the SAME 61 classes. `.data/ontologies` carries the host upper
    // WITHOUT the LearningArtifact axis, and one database read through two
    // vocabularies is decided by how the process happened to be launched.
    ontologyDir: path.join(root, '.data', 'ontologies', 'obs-api'),
    // No `domains`. It is a TOPIC slot, not a tenant slot — see
    // sse-server.ts, which documents the measurement. A tenant name here
    // matches nothing and makes the export filename scope-dependent.
    debounceMs: 5000,
  });

  try {
    await store.open();
  } catch (e) {
    // Name the real cause. The generic "Database failed to open" is what made
    // the equivalent wave-analysis bug take three months to find.
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `cannot open the knowledge graph at ${dbPath}: ${msg}\n` +
        'km-core LevelDB is single-owner-rw. On the host that owner is obs-api ' +
        '(port 12436). Either run inside it, or restart it:\n' +
        '  launchctl kickstart -k gui/$(id -u)/com.coding.obs-api',
    );
  }

  const adapter = createKmCoreAdapter({ store, team: opts.team });
  let released = false;
  return {
    store,
    adapter,
    owned: true,
    release: async () => {
      if (released) return;
      released = true;
      await adapter.close();
    },
  };
}

function borrow(store: object, team: string): AcquiredStore {
  return {
    store,
    adapter: createKmCoreAdapter({ store: store as never, team }),
    owned: false,
    // Deliberately empty. The host opened it and keeps using it after we
    // finish; closing it would persist the whole graph and drop its handle.
    release: async () => {},
  };
}
