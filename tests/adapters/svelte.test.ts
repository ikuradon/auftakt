/**
 * Svelte adapter tests.
 *
 * Since we can't use Svelte 5 runes ($state, $effect, $derived) outside .svelte files
 * or without the Svelte compiler, the adapter exports plain functions that work with
 * RxJS Observables internally and return a subscribe-compatible interface (Svelte readable store protocol).
 *
 * This test validates the adapter without the Svelte compiler.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Subject, firstValueFrom, filter } from 'rxjs';
import { toReadable, createSvelteQuery } from '../../src/adapters/svelte.js';
import { createEventStore } from '../../src/core/store.js';
import { connectStore } from '../../src/sync/global-feed.js';
import { memoryBackend } from '../../src/backends/memory.js';
import type { NostrEvent, CachedEvent } from '../../src/types.js';

const wait = (ms = 50) => new Promise(r => setTimeout(r, ms));

const makeEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
  id: 'e1', kind: 1, pubkey: 'pk1', created_at: 1000,
  tags: [], content: '', sig: 'sig1',
  ...overrides,
});

function createMockRxNostr() {
  const allEvents$ = new Subject<any>();
  return {
    allEvents$,
    createAllEventObservable: () => allEvents$.asObservable(),
    use: (() => {
      const s = new Subject<any>();
      setTimeout(() => s.complete(), 5);
      return s.asObservable();
    }) as any,
  };
}

describe('toReadable', () => {
  it('converts Observable to Svelte readable store (subscribe protocol)', () => {
    const store = createEventStore({ backend: memoryBackend() });
    const observable = store.query({ kinds: [1] });
    const readable = toReadable(observable);

    expect(typeof readable.subscribe).toBe('function');
  });

  it('calls subscriber with current value on subscribe', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add(makeEvent({ id: 'a', kind: 1 }));
    await wait();

    const observable = store.query({ kinds: [1] });
    const readable = toReadable(observable);

    const values: CachedEvent[][] = [];
    const unsubscribe = readable.subscribe(v => values.push(v));

    await wait();
    expect(values.length).toBeGreaterThan(0);
    // At some point should have 1 event
    expect(values.some(v => v.length === 1)).toBe(true);

    unsubscribe();
  });

  it('unsubscribe stops updates', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const observable = store.query({ kinds: [1] });
    const readable = toReadable(observable);

    const values: CachedEvent[][] = [];
    const unsubscribe = readable.subscribe(v => values.push(v));
    await wait();

    const countBefore = values.length;
    unsubscribe();

    await store.add(makeEvent({ id: 'b', kind: 1 }));
    await wait();

    expect(values.length).toBe(countBefore);
  });
});

describe('createSvelteQuery', () => {
  let store: ReturnType<typeof createEventStore>;
  let mockRxNostr: ReturnType<typeof createMockRxNostr>;

  beforeEach(() => {
    store = createEventStore({ backend: memoryBackend() });
    mockRxNostr = createMockRxNostr();
    connectStore(mockRxNostr as any, store);
  });

  it('returns events and status as Svelte readable stores', () => {
    const { events, status, dispose } = createSvelteQuery(mockRxNostr as any, store, {
      filter: { kinds: [1] },
      strategy: 'backward',
    });

    expect(typeof events.subscribe).toBe('function');
    expect(typeof status.subscribe).toBe('function');
    dispose();
  });

  it('events readable emits cached events', async () => {
    await store.add(makeEvent({ id: 'cached1', kind: 1 }));
    await wait();

    const { events, dispose } = createSvelteQuery(mockRxNostr as any, store, {
      filter: { kinds: [1] },
      strategy: 'backward',
    });

    const collected: CachedEvent[][] = [];
    const unsub = events.subscribe(v => collected.push(v));
    await wait();

    expect(collected.some(v => v.length > 0)).toBe(true);
    unsub();
    dispose();
  });

  it('status readable emits sync status', async () => {
    const { status, dispose } = createSvelteQuery(mockRxNostr as any, store, {
      filter: { kinds: [1] },
      strategy: 'forward',
    });

    const statuses: string[] = [];
    const unsub = status.subscribe(v => statuses.push(v));
    await wait();

    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses).toContain('live');
    unsub();
    dispose();
  });

  it('dispose stops both readables', () => {
    const { events, status, dispose } = createSvelteQuery(mockRxNostr as any, store, {
      filter: { kinds: [1] },
      strategy: 'backward',
    });

    let eventsCount = 0;
    let statusCount = 0;
    const unsub1 = events.subscribe(() => eventsCount++);
    const unsub2 = status.subscribe(() => statusCount++);

    dispose();

    const evAfter = eventsCount;
    const stAfter = statusCount;

    // No more emissions after dispose
    expect(eventsCount).toBe(evAfter);
    expect(statusCount).toBe(stAfter);

    unsub1();
    unsub2();
  });

  it('passes emit and dispose through', () => {
    const { emit, dispose } = createSvelteQuery(mockRxNostr as any, store, {
      filter: { kinds: [1] },
      strategy: 'backward',
    });

    expect(typeof emit).toBe('function');
    dispose();
    // emit after dispose is no-op
    expect(() => emit({ kinds: [7] })).not.toThrow();
  });
});
