import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Subject } from 'rxjs';
import { connectStore } from '../../src/sync/global-feed.js';
import { createSyncedQuery } from '../../src/sync/synced-query.js';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';

const wait = (ms = 50) => new Promise(r => setTimeout(r, ms));

function createMockRxNostr() {
  const allEvents$ = new Subject<any>();
  return {
    allEvents$,
    createAllEventObservable: () => allEvents$.asObservable(),
    use: vi.fn(() => {
      const s = new Subject<any>();
      setTimeout(() => s.complete(), 5);
      return s.asObservable();
    }),
  };
}

describe('connectStore + SyncedQuery filter mismatch warning', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('warns when SyncedQuery requests a kind excluded by connectStore filter', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const mock = createMockRxNostr();

    const disconnect = connectStore(mock as any, store, {
      filter: (event) => event.kind !== 4,
    });

    const { dispose } = createSyncedQuery(
      mock as any,
      store,
      { filter: { kinds: [4] }, strategy: 'backward' },
    );

    await wait();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[auftakt]'),
      expect.stringContaining('kind'),
    );

    dispose();
    disconnect();
    warnSpy.mockRestore();
  });

  it('does not warn when kinds are not excluded', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const mock = createMockRxNostr();

    const disconnect = connectStore(mock as any, store, {
      filter: (event) => event.kind !== 4,
    });

    const { dispose } = createSyncedQuery(
      mock as any,
      store,
      { filter: { kinds: [1] }, strategy: 'backward' },
    );

    await wait();

    expect(warnSpy).not.toHaveBeenCalled();

    dispose();
    disconnect();
    warnSpy.mockRestore();
  });

  it('does not warn when no connectStore filter is set', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const mock = createMockRxNostr();

    const disconnect = connectStore(mock as any, store);

    const { dispose } = createSyncedQuery(
      mock as any,
      store,
      { filter: { kinds: [4] }, strategy: 'backward' },
    );

    await wait();

    expect(warnSpy).not.toHaveBeenCalled();

    dispose();
    disconnect();
    warnSpy.mockRestore();
  });
});
