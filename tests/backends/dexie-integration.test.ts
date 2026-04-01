import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { firstValueFrom, skip } from 'rxjs';
import { createEventStore, type EventStore } from '../../src/core/store.js';
import { dexieBackend } from '../../src/backends/dexie.js';
import { cachedBackend } from '../../src/backends/cached.js';
import type { StorageBackend } from '../../src/backends/interface.js';
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

const flush = () => new Promise((r) => setTimeout(r, 30));

describe('store + dexieBackend integration', () => {
  let store: EventStore;
  let backend: StorageBackend;

  beforeEach(() => {
    backend = dexieBackend({ dbName: `int-${Date.now()}-${Math.random()}` });
    store = createEventStore({ backend });
  });

  afterEach(async () => {
    store.dispose();
    await backend.dispose?.();
  });

  it('add + getSync round-trips', async () => {
    await store.add(makeEvent({ id: 'e1' }));
    const results = await store.getSync({ ids: ['e1'] });
    expect(results).toHaveLength(1);
    expect(results[0].event.id).toBe('e1');
  });

  it('reactive query emits on add', async () => {
    const events$ = store.query({ kinds: [1] });
    // Wait for initial empty emit + backend query to settle
    await flush();
    const first = firstValueFrom(events$.pipe(skip(1)));
    await store.add(makeEvent({ id: 'e1', kind: 1 }));
    await flush();
    const result = await first;
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some((e) => e.event.id === 'e1')).toBe(true);
  });

  it('duplicate returns duplicate', async () => {
    await store.add(makeEvent({ id: 'e1' }));
    const result = await store.add(makeEvent({ id: 'e1' }));
    expect(result).toBe('duplicate');
  });

  it('ephemeral events are rejected', async () => {
    const result = await store.add(makeEvent({ kind: 20001 }));
    expect(result).toBe('ephemeral');
  });

  it('replaceable event replaces older', async () => {
    await store.add(makeEvent({ id: 'r1', kind: 0, pubkey: 'pk1', created_at: 100 }));
    const result = await store.add(
      makeEvent({ id: 'r2', kind: 0, pubkey: 'pk1', created_at: 200 }),
    );
    expect(result).toBe('replaced');
    const remaining = await store.getSync({ kinds: [0], authors: ['pk1'] });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].event.id).toBe('r2');
  });

  it('addressable event replaces by d-tag', async () => {
    await store.add(
      makeEvent({ id: 'a1', kind: 30023, pubkey: 'pk1', created_at: 100, tags: [['d', 'slug']] }),
    );
    const result = await store.add(
      makeEvent({ id: 'a2', kind: 30023, pubkey: 'pk1', created_at: 200, tags: [['d', 'slug']] }),
    );
    expect(result).toBe('replaced');
    const remaining = await store.getSync({ kinds: [30023] });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].event.id).toBe('a2');
  });

  it('kind:5 e-tag deletion removes target', async () => {
    await store.add(makeEvent({ id: 'target', kind: 1, pubkey: 'pk1' }));
    await store.add(
      makeEvent({
        id: 'del1',
        kind: 5,
        pubkey: 'pk1',
        created_at: 2000,
        tags: [['e', 'target']],
      }),
    );
    const remaining = await store.getSync({ ids: ['target'] });
    expect(remaining).toHaveLength(0);
  });

  it('kind:5 e-tag persists: re-adding deleted event returns deleted', async () => {
    await store.add(makeEvent({ id: 'target', kind: 1, pubkey: 'pk1' }));
    await store.add(
      makeEvent({
        id: 'del1',
        kind: 5,
        pubkey: 'pk1',
        created_at: 2000,
        tags: [['e', 'target']],
      }),
    );
    const result = await store.add(makeEvent({ id: 'target', kind: 1, pubkey: 'pk1' }));
    expect(result).toBe('deleted');
  });

  it('kind:5 a-tag deletion removes addressable', async () => {
    await store.add(
      makeEvent({ id: 'a1', kind: 30023, pubkey: 'pk1', created_at: 1000, tags: [['d', 'slug']] }),
    );
    await store.add(
      makeEvent({
        id: 'del1',
        kind: 5,
        pubkey: 'pk1',
        created_at: 2000,
        tags: [['a', '30023:pk1:slug']],
      }),
    );
    const remaining = await store.getSync({ kinds: [30023] });
    // Only the kind:5 event itself (if applicable) or nothing
    expect(remaining.filter((e) => e.event.kind === 30023)).toHaveLength(0);
  });

  it('kind:5 a-tag persists: older addressable is rejected', async () => {
    await store.add(
      makeEvent({
        id: 'del1',
        kind: 5,
        pubkey: 'pk1',
        created_at: 5000,
        tags: [['a', '30023:pk1:slug']],
      }),
    );
    const result = await store.add(
      makeEvent({ id: 'a1', kind: 30023, pubkey: 'pk1', created_at: 3000, tags: [['d', 'slug']] }),
    );
    expect(result).toBe('deleted');
  });

  it('kind:5 a-tag allows newer addressable', async () => {
    await store.add(
      makeEvent({
        id: 'del1',
        kind: 5,
        pubkey: 'pk1',
        created_at: 3000,
        tags: [['a', '30023:pk1:slug']],
      }),
    );
    const result = await store.add(
      makeEvent({ id: 'a1', kind: 30023, pubkey: 'pk1', created_at: 5000, tags: [['d', 'slug']] }),
    );
    expect(result).toBe('added');
  });

  it('store.delete removes event', async () => {
    await store.add(makeEvent({ id: 'e1' }));
    await store.delete('e1');
    const remaining = await store.getSync({ ids: ['e1'] });
    expect(remaining).toHaveLength(0);
  });

  it('count returns correct number', async () => {
    await store.add(makeEvent({ id: 'e1', kind: 1 }));
    await store.add(makeEvent({ id: 'e2', kind: 1, created_at: 2000 }));
    await store.add(makeEvent({ id: 'e3', kind: 7, created_at: 3000 }));
    const count = await store.count({ kinds: [1] });
    expect(count).toBe(2);
  });

  it('NIP-40 expired events are rejected', async () => {
    const result = await store.add(
      makeEvent({
        id: 'exp1',
        tags: [['expiration', '1']],
      }),
    );
    expect(result).toBe('expired');
  });

  it('seenOn is updated on duplicate from different relay', async () => {
    await store.add(makeEvent({ id: 'e1' }), { relay: 'wss://r1' });
    await store.add(makeEvent({ id: 'e1' }), { relay: 'wss://r2' });
    await flush();
    const events = await firstValueFrom(store.query({ ids: ['e1'] }).pipe(skip(1)));
    expect(events[0].seenOn).toContain('wss://r1');
    expect(events[0].seenOn).toContain('wss://r2');
  });
});

describe('cachedBackend + dexieBackend integration', () => {
  let store: EventStore;
  let inner: StorageBackend;

  beforeEach(() => {
    inner = dexieBackend({ dbName: `cached-int-${Date.now()}-${Math.random()}` });
    const cached = cachedBackend(inner, { maxCached: 1000 });
    store = createEventStore({ backend: cached });
  });

  afterEach(async () => {
    store.dispose();
    await inner.dispose?.();
  });

  it('add + getSync through cached layer', async () => {
    await store.add(makeEvent({ id: 'c1' }));
    const results = await store.getSync({ ids: ['c1'] });
    expect(results).toHaveLength(1);
    expect(results[0].event.id).toBe('c1');
  });

  it('kind:5 deletion persists through cached layer', async () => {
    await store.add(makeEvent({ id: 'target', kind: 1, pubkey: 'pk1' }));
    await store.add(
      makeEvent({
        id: 'del1',
        kind: 5,
        pubkey: 'pk1',
        created_at: 2000,
        tags: [['e', 'target']],
      }),
    );
    const result = await store.add(makeEvent({ id: 'target', kind: 1, pubkey: 'pk1' }));
    expect(result).toBe('deleted');
  });

  it('reactive query works through cached layer', async () => {
    const events$ = store.query({ kinds: [1] });
    await flush();
    const first = firstValueFrom(events$.pipe(skip(1)));
    await store.add(makeEvent({ id: 'c2', kind: 1 }));
    await flush();
    const result = await first;
    expect(result.some((e) => e.event.id === 'c2')).toBe(true);
  });
});
