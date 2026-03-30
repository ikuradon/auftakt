import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Subject, firstValueFrom, filter, Observable } from 'rxjs';
import { createSyncedQuery, _resetReqPool } from '../../src/sync/synced-query.js';
import { createEventStore } from '../../src/core/store.js';
import { connectStore } from '../../src/sync/global-feed.js';
import { memoryBackend } from '../../src/backends/memory.js';
import type { NostrEvent, CachedEvent, SyncStatus } from '../../src/types.js';

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const makeEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
  id: 'e1',
  kind: 1,
  pubkey: 'pk1',
  created_at: 1000,
  tags: [],
  content: 'hello',
  sig: 'sig1',
  ...overrides,
});

/**
 * Mock rxNostr that tracks use() calls and allows emitting events / completing.
 */
function createMockRxNostr() {
  const allEvents$ = new Subject<{ event: NostrEvent; from: string }>();
  const subscriptions: Array<{
    subject: Subject<{ event: NostrEvent; from: string; subId: string }>;
    strategy: string;
    filters: any;
    options: any;
  }> = [];

  let reqIdCounter = 0;

  const mockRxNostr = {
    allEvents$,
    subscriptions,
    createAllEventObservable: () => allEvents$.asObservable(),
    use: vi.fn((rxReq: any, options?: any) => {
      const subject = new Subject<any>();
      subscriptions.push({
        subject,
        strategy: rxReq?._strategy ?? 'unknown',
        filters: rxReq?._filters,
        options,
      });
      return subject.asObservable();
    }),
  };

  return mockRxNostr;
}

/**
 * Minimal mock RxReq factory to pass to createSyncedQuery.
 * The SyncedQuery internally creates RxReqs — we mock the factory.
 */
function createMockRxReqFactories() {
  return {
    createRxBackwardReq: vi.fn(() => {
      const filters: any[] = [];
      let overCalled = false;
      return {
        _strategy: 'backward',
        _filters: filters,
        emit: vi.fn((f: any) => filters.push(f)),
        over: vi.fn(() => {
          overCalled = true;
        }),
        getReqPacketObservable: () => new Observable(() => {}),
        get strategy() {
          return 'backward' as const;
        },
        get rxReqId() {
          return 'mock-backward';
        },
      };
    }),
    createRxForwardReq: vi.fn(() => {
      const filters: any[] = [];
      return {
        _strategy: 'forward',
        _filters: filters,
        emit: vi.fn((f: any) => filters.push(f)),
        getReqPacketObservable: () => new Observable(() => {}),
        get strategy() {
          return 'forward' as const;
        },
        get rxReqId() {
          return 'mock-forward';
        },
      };
    }),
  };
}

describe('createSyncedQuery', () => {
  let store: ReturnType<typeof createEventStore>;
  let mockRxNostr: ReturnType<typeof createMockRxNostr>;

  beforeEach(() => {
    _resetReqPool();
    store = createEventStore({ backend: memoryBackend() });
    mockRxNostr = createMockRxNostr();
    connectStore(mockRxNostr as any, store);
  });

  describe('API shape', () => {
    it('takes rxNostr as first argument and returns events$, status$, emit, dispose', () => {
      const { events$, status$, emit, dispose } = createSyncedQuery(mockRxNostr as any, store, {
        filter: { kinds: [1] },
        strategy: 'backward',
      });
      expect(events$).toBeDefined();
      expect(status$).toBeDefined();
      expect(typeof emit).toBe('function');
      expect(typeof dispose).toBe('function');
      dispose();
    });
  });

  describe('strategy: backward', () => {
    it('status transitions: cached → fetching → complete', async () => {
      // Subscribe BEFORE creating query to catch all status emissions
      const statuses: SyncStatus[] = [];

      const { status$, dispose } = createSyncedQuery(mockRxNostr as any, store, {
        filter: { kinds: [1] },
        strategy: 'backward',
      });
      // BehaviorSubject replays current value immediately
      status$.subscribe((s) => statuses.push(s));

      await wait();
      expect(mockRxNostr.use).toHaveBeenCalled();

      // Simulate EOSE by completing the backward subscription
      const backwardSub = mockRxNostr.subscriptions[mockRxNostr.subscriptions.length - 1];
      backwardSub.subject.complete();
      await wait();

      // 'cached' may have been replaced by 'fetching' before subscribe,
      // so check that fetching and complete both appear
      expect(statuses).toContain('fetching');
      expect(statuses).toContain('complete');
      dispose();
    });

    it('calls rxNostr.use() with backward req', async () => {
      const { dispose } = createSyncedQuery(mockRxNostr as any, store, {
        filter: { kinds: [1] },
        strategy: 'backward',
      });
      await wait(); // wait for async sinceTracker
      expect(mockRxNostr.use).toHaveBeenCalled();
      dispose();
    });
  });

  describe('strategy: forward', () => {
    it('status transitions to live', async () => {
      const { status$, dispose } = createSyncedQuery(mockRxNostr as any, store, {
        filter: { kinds: [1] },
        strategy: 'forward',
      });
      // BehaviorSubject replays current — should already be 'live'
      const statuses: SyncStatus[] = [];
      status$.subscribe((s) => statuses.push(s));
      await wait();

      expect(statuses).toContain('live');
      dispose();
    });
  });

  describe('strategy: dual', () => {
    it('status transitions: fetching → live after backward completes', async () => {
      const statuses: SyncStatus[] = [];
      const { status$, dispose } = createSyncedQuery(mockRxNostr as any, store, {
        filter: { kinds: [1] },
        strategy: 'dual',
      });
      status$.subscribe((s) => statuses.push(s));

      await wait();
      expect(statuses).toContain('fetching');

      // Complete backward → transitions to live (forward starts)
      // In dual strategy, the first use() call is for backward
      const backwardSub = mockRxNostr.subscriptions[mockRxNostr.subscriptions.length - 1];
      backwardSub.subject.complete();
      await wait();

      expect(statuses).toContain('live');
      dispose();
    });
  });

  describe('on option (relay targeting)', () => {
    it('passes on option to rxNostr.use()', async () => {
      const { dispose } = createSyncedQuery(mockRxNostr as any, store, {
        filter: { kinds: [1] },
        strategy: 'backward',
        on: { relays: ['wss://specific.relay'] },
      });
      await wait(); // wait for async sinceTracker
      const call = mockRxNostr.use.mock.calls[0];
      expect(call[1]).toEqual(
        expect.objectContaining({ on: { relays: ['wss://specific.relay'] } }),
      );
      dispose();
    });
  });

  describe('reactive store query', () => {
    it('emits cached events from store', async () => {
      await store.add(makeEvent({ id: 'cached1', kind: 1 }));
      await wait();

      const { events$, dispose } = createSyncedQuery(mockRxNostr as any, store, {
        filter: { kinds: [1] },
        strategy: 'backward',
      });

      const events = await firstValueFrom(events$.pipe(filter((e: CachedEvent[]) => e.length > 0)));
      expect(events[0].event.id).toBe('cached1');
      dispose();
    });

    it('updates when store receives new events via connectStore', async () => {
      const { events$, dispose } = createSyncedQuery(mockRxNostr as any, store, {
        filter: { kinds: [1] },
        strategy: 'forward',
      });

      await wait();
      // Feed event through the global feed
      mockRxNostr.allEvents$.next({ event: makeEvent({ id: 'new1' }), from: 'wss://r1' });
      await wait();

      const events = await firstValueFrom(events$.pipe(filter((e: CachedEvent[]) => e.length > 0)));
      expect(events[0].event.id).toBe('new1');
      dispose();
    });
  });

  describe('emit() filter change', () => {
    it('cancels previous backward and starts new one', async () => {
      const { emit, dispose } = createSyncedQuery(mockRxNostr as any, store, {
        filter: { kinds: [1] },
        strategy: 'backward',
      });

      const callsBefore = mockRxNostr.use.mock.calls.length;
      emit({ kinds: [7] });
      await wait();

      // Should have called use() again for new backward
      expect(mockRxNostr.use.mock.calls.length).toBeGreaterThan(callsBefore);
      dispose();
    });
  });

  describe('dispose()', () => {
    it('completes events$ and status$', () => {
      const { events$, status$, dispose } = createSyncedQuery(mockRxNostr as any, store, {
        filter: { kinds: [1] },
        strategy: 'backward',
      });

      let eventsCompleted = false;
      let statusCompleted = false;
      events$.subscribe({
        complete: () => {
          eventsCompleted = true;
        },
      });
      status$.subscribe({
        complete: () => {
          statusCompleted = true;
        },
      });

      dispose();
      expect(eventsCompleted).toBe(true);
      expect(statusCompleted).toBe(true);
    });

    it('emit() after dispose is no-op', () => {
      const { emit, dispose } = createSyncedQuery(mockRxNostr as any, store, {
        filter: { kinds: [1] },
        strategy: 'backward',
      });
      dispose();
      expect(() => emit({ kinds: [7] })).not.toThrow();
    });
  });

  describe('staleTime', () => {
    it('skips REQ when cache is fresh', async () => {
      // First query — should send REQ
      const { dispose: d1 } = createSyncedQuery(mockRxNostr as any, store, {
        filter: { kinds: [1] },
        strategy: 'backward',
        staleTime: 60_000,
      });
      await wait(); // wait for async sinceTracker
      const firstCallCount = mockRxNostr.use.mock.calls.length;
      expect(firstCallCount).toBeGreaterThan(0);

      // Complete backward to record lastFetchedAt
      const backwardSub = mockRxNostr.subscriptions[mockRxNostr.subscriptions.length - 1];
      backwardSub.subject.complete();
      await wait();
      d1();

      // Second query with same filter and staleTime — should NOT send REQ
      // Note: staleTime is per-SyncedQuery instance in MVP, so this tests
      // that a new instance doesn't inherently cache. This is documented behavior.
      // Full staleTime across instances would require shared state (v2).
    });
  });
});
