import { describe, it, expect, vi } from 'vitest';
import { Subject, firstValueFrom, filter } from 'rxjs';
import { reconcileDeletions } from '../../src/sync/deletion-reconcile.js';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import type { NostrEvent, CachedEvent } from '../../src/types.js';

const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));

const makeEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
  id: 'e1', kind: 1, pubkey: 'pk1', created_at: 1000,
  tags: [], content: '', sig: 'sig1',
  ...overrides,
});

describe('reconcileDeletions', () => {
  it('fetches kind:5 for given event ids and applies deletions', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add(makeEvent({ id: 'target1', kind: 1, pubkey: 'pk1' }));
    await store.add(makeEvent({ id: 'target2', kind: 1, pubkey: 'pk1' }));

    const mockRxNostr = {
      use: vi.fn((_req: any) => {
        const subject = new Subject<any>();
        setTimeout(() => {
          subject.next({
            event: makeEvent({
              id: 'del1', kind: 5, pubkey: 'pk1', created_at: 2000,
              tags: [['e', 'target1']],
            }),
            from: 'wss://relay1',
          });
          subject.complete();
        }, 5);
        return subject.asObservable();
      }),
    };

    await reconcileDeletions(mockRxNostr as any, store, ['target1', 'target2']);
    await wait(50);

    // Verify via add result — re-adding target1 should return 'deleted'
    const result1 = await store.add(makeEvent({ id: 'target1', kind: 1, pubkey: 'pk1' }));
    expect(result1).toBe('deleted');

    // target2 should still be addable (duplicate since it exists)
    const result2 = await store.add(makeEvent({ id: 'target2', kind: 1, pubkey: 'pk1' }));
    expect(result2).toBe('duplicate');
  });

  it('handles empty eventIds gracefully', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const mockRxNostr = { use: vi.fn() };
    await reconcileDeletions(mockRxNostr as any, store, []);
    expect(mockRxNostr.use).not.toHaveBeenCalled();
  });

  it('handles undefined eventIds', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const mockRxNostr = { use: vi.fn() };
    await reconcileDeletions(mockRxNostr as any, store);
    expect(mockRxNostr.use).not.toHaveBeenCalled();
  });

  it('chunks large id lists into batches of 50', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const mockRxNostr = {
      use: vi.fn(() => {
        const subject = new Subject<any>();
        setTimeout(() => subject.complete(), 5);
        return subject.asObservable();
      }),
    };

    const ids = Array.from({ length: 120 }, (_, i) => `id${i}`);
    await reconcileDeletions(mockRxNostr as any, store, ids);
    await wait(50);

    // 120 ids / 50 per chunk = 3 calls
    expect(mockRxNostr.use).toHaveBeenCalledTimes(3);
  });
});
