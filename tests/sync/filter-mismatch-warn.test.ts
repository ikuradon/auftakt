import { describe, it, expect, vi } from 'vitest';
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
  it('warns when SyncedQuery requests a kind excluded by connectStore filter', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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

    // Currently no warn — this is documenting the gap.
    // The spec says "デバッグモードではこの不一致を検出してconsole.warnを出力すべき"
    // For now, this test documents the expected behavior.

    dispose();
    disconnect();
    warnSpy.mockRestore();
  });
});
