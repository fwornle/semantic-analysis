/**
 * km-store-host — ownership, and the two failures it exists to prevent.
 *
 * These are the regressions that matter:
 *
 *   H1  A borrowed store must never be closed. `GraphKMStore.close()` persists
 *       the WHOLE graph (persistOnClose defaults true) and then closes the
 *       LevelDB handle, so closing one you borrowed takes down the handle its
 *       owner is still serving /api/v1 from. The adapter's own comment claimed
 *       close() was a no-op for four months, which is why this needs a test and
 *       not a convention.
 *
 *   H2  A registered provider that returns null must THROW, not fall back to
 *       opening a private store. The fallback would be a second LevelDB handle
 *       on the same directory — two in-memory graphs over one database, each
 *       rewriting all of it on close.
 *
 * Only the borrow paths are covered here. The private-store path needs a real
 * LevelDB and a real ontology registry, which belongs in an integration test;
 * what is asserted instead is that it is not reached when it must not be.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireKmStore,
  setKmStoreProvider,
  clearKmStoreProvider,
  hasKmStoreProvider,
  KmStoreNotReadyError,
} from './km-store-host.js';

/** A store stand-in that records whether anybody closed it. */
function fakeStore() {
  const calls = { close: 0 };
  return {
    calls,
    store: {
      close: async () => { calls.close += 1; },
      // createKmCoreAdapter only reaches into the store on an actual operation,
      // so the surface can stay this thin for ownership tests.
      graph: {},
    },
  };
}

beforeEach(() => clearKmStoreProvider());
afterEach(() => clearKmStoreProvider());

describe('provider registration', () => {
  test('no provider is registered by default', () => {
    assert.equal(hasKmStoreProvider(), false);
  });

  test('clearKmStoreProvider un-registers', () => {
    setKmStoreProvider(() => null);
    assert.equal(hasKmStoreProvider(), true);
    clearKmStoreProvider();
    assert.equal(hasKmStoreProvider(), false);
  });
});

describe('borrowing the hosted store', () => {
  test('a hosted store is borrowed, not owned', async () => {
    const { store } = fakeStore();
    setKmStoreProvider(() => store);
    const acquired = await acquireKmStore({ team: 'raas' });
    assert.equal(acquired.owned, false);
    assert.equal(acquired.store, store);
  });

  test('release() never closes a borrowed store', async () => {
    // H1. If this ever fails, every create_ukb_entity_with_insight call takes
    // sse-server's /api/v1 surface down with it.
    const { store, calls } = fakeStore();
    setKmStoreProvider(() => store);
    const acquired = await acquireKmStore({ team: 'raas' });
    await acquired.release();
    await acquired.release();
    assert.equal(calls.close, 0, 'a borrowed store must not be closed');
  });

  test('an explicit injection wins over a registered provider', async () => {
    // obs-api injects through WaveControllerConfig.kmStore in a DIFFERENT
    // process from the one holding this module singleton, so both routes have to
    // keep working and the explicit one has to win.
    const hosted = fakeStore();
    const injected = fakeStore();
    setKmStoreProvider(() => hosted.store);
    const acquired = await acquireKmStore({ team: 'raas', injected: injected.store });
    assert.equal(acquired.store, injected.store);
    assert.equal(acquired.owned, false);
    await acquired.release();
    assert.equal(injected.calls.close, 0);
    assert.equal(hosted.calls.close, 0);
  });

  test('an injection is honoured with no provider registered', async () => {
    const { store } = fakeStore();
    const acquired = await acquireKmStore({ team: 'raas', injected: store });
    assert.equal(acquired.store, store);
    assert.equal(acquired.owned, false);
  });
});

describe('a host that is not ready yet', () => {
  test('a provider returning null throws instead of opening a second handle', async () => {
    // H2. The tempting "fall back to a private store" is precisely the
    // double-open this module exists to prevent.
    setKmStoreProvider(() => null);
    await assert.rejects(
      () => acquireKmStore({ team: 'raas' }),
      (err: unknown) => {
        assert.ok(err instanceof KmStoreNotReadyError);
        // The message has to tell the caller to retry rather than to restart
        // something — this state is transient by construction.
        assert.match((err as Error).message, /retry/i);
        return true;
      },
    );
  });

  test('a null provider plus an explicit injection still succeeds', async () => {
    // The injection is a store the caller already holds open, so "the host is
    // hydrating" is irrelevant to it.
    const { store } = fakeStore();
    setKmStoreProvider(() => null);
    const acquired = await acquireKmStore({ team: 'raas', injected: store });
    assert.equal(acquired.store, store);
  });
});
