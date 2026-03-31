import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Subject, firstValueFrom } from 'rxjs';
import { createSyncedQuery, _resetReqPool } from '../../src/sync/synced-query.js';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import type { NostrEvent } from '../../src/types.js';

const makeEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
  id: 'e1',
  kind: 1,
  pubkey: 'pk1',
  created_at: 1000,
  tags: [],
  content: '',
  sig: 'sig1',
  ...overrides,
});

function createMockRxNostr() {
  return {
    use: vi.fn(() => {
      const subject = new Subject<{ event: NostrEvent; from: string }>();
      setTimeout(() => subject.complete(), 50);
      return subject.asObservable();
    }),
  };
}

describe('createSyncedQuery with AbortSignal', () => {
  beforeEach(() => {
    _resetReqPool();
  });

  it('disposes on abort signal', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const rxNostr = createMockRxNostr();
    const controller = new AbortController();

    const { events$, status$ } = createSyncedQuery(rxNostr, store, {
      filter: { kinds: [1] },
      strategy: 'backward',
      signal: controller.signal,
    });

    let eventsCompleted = false;
    let statusCompleted = false;
    events$.subscribe({ complete: () => (eventsCompleted = true) });
    status$.subscribe({ complete: () => (statusCompleted = true) });

    controller.abort();

    expect(eventsCompleted).toBe(true);
    expect(statusCompleted).toBe(true);
  });

  it('emit is no-op after abort', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const rxNostr = createMockRxNostr();
    const controller = new AbortController();

    const { emit } = createSyncedQuery(rxNostr, store, {
      filter: { kinds: [1] },
      strategy: 'backward',
      signal: controller.signal,
    });

    controller.abort();

    // Should not throw
    emit({ kinds: [7] });
  });

  it('does not create subscriptions if already aborted', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const rxNostr = createMockRxNostr();
    const controller = new AbortController();
    controller.abort(); // abort before creating

    const { events$ } = createSyncedQuery(rxNostr, store, {
      filter: { kinds: [1] },
      strategy: 'backward',
      signal: controller.signal,
    });

    let eventsCompleted = false;
    events$.subscribe({ complete: () => (eventsCompleted = true) });

    expect(eventsCompleted).toBe(true);
  });
});
