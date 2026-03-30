import { describe, it, expect, beforeEach } from 'vitest';
import { firstValueFrom, filter } from 'rxjs';
import { createSyncedQuery } from '../../src/sync/synced-query.js';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import type { NostrEvent, CachedEvent } from '../../src/types.js';

const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));

const makeEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
  id: 'e1', kind: 1, pubkey: 'pk1', created_at: 1000,
  tags: [], content: 'hello', sig: 'sig1',
  ...overrides,
});

describe('createSyncedQuery', () => {
  let store: ReturnType<typeof createEventStore>;

  beforeEach(() => {
    store = createEventStore({ backend: memoryBackend() });
  });

  it('returns events$ and status$', () => {
    const { events$, status$, dispose } = createSyncedQuery(store, {
      filter: { kinds: [1] },
      strategy: 'backward',
    });
    expect(events$).toBeDefined();
    expect(status$).toBeDefined();
    dispose();
  });

  it('emits cached events via store.query()', async () => {
    await store.add(makeEvent({ id: 'cached1', kind: 1 }));
    await wait();

    const { events$, dispose } = createSyncedQuery(store, {
      filter: { kinds: [1] },
      strategy: 'backward',
    });

    // Wait for query to flush and emit non-empty results
    const events = await firstValueFrom(
      events$.pipe(filter((e: CachedEvent[]) => e.length > 0))
    );
    expect(events).toHaveLength(1);
    expect(events[0].event.id).toBe('cached1');
    dispose();
  });

  it('status$ starts with cached', async () => {
    const { status$, dispose } = createSyncedQuery(store, {
      filter: { kinds: [1] },
      strategy: 'backward',
    });

    const first = await firstValueFrom(status$);
    expect(first).toBe('cached');
    dispose();
  });

  it('dispose completes events$ and status$', () => {
    const { events$, status$, dispose } = createSyncedQuery(store, {
      filter: { kinds: [1] },
      strategy: 'backward',
    });

    let eventsCompleted = false;
    let statusCompleted = false;
    events$.subscribe({ complete: () => { eventsCompleted = true; } });
    status$.subscribe({ complete: () => { statusCompleted = true; } });

    dispose();
    expect(eventsCompleted).toBe(true);
    expect(statusCompleted).toBe(true);
  });

  it('emit() after dispose() is no-op', () => {
    const { emit, dispose } = createSyncedQuery(store, {
      filter: { kinds: [1] },
      strategy: 'backward',
    });

    dispose();
    expect(() => emit({ kinds: [7] })).not.toThrow();
  });

  it('emit() updates filter and re-queries', async () => {
    await store.add(makeEvent({ id: 'a', kind: 1 }));
    await store.add(makeEvent({ id: 'b', kind: 7 }));
    await wait();

    const { events$, emit, dispose } = createSyncedQuery(store, {
      filter: { kinds: [1] },
      strategy: 'backward',
    });

    const kind1 = await firstValueFrom(
      events$.pipe(filter((e: CachedEvent[]) => e.length > 0))
    );
    expect(kind1).toHaveLength(1);
    expect(kind1[0].event.id).toBe('a');

    emit({ kinds: [7] });
    await wait();
    const kind7 = await firstValueFrom(
      events$.pipe(filter((e: CachedEvent[]) => e.length > 0 && e[0].event.kind === 7))
    );
    expect(kind7).toHaveLength(1);
    expect(kind7[0].event.id).toBe('b');

    dispose();
  });

  it('reactively updates when store changes', async () => {
    const { events$, dispose } = createSyncedQuery(store, {
      filter: { kinds: [1] },
      strategy: 'forward',
    });

    const initial = await firstValueFrom(events$);
    expect(initial).toHaveLength(0);

    await store.add(makeEvent({ id: 'new1' }));
    await wait();

    const updated = await firstValueFrom(
      events$.pipe(filter((e: CachedEvent[]) => e.length > 0))
    );
    expect(updated).toHaveLength(1);
    dispose();
  });
});
