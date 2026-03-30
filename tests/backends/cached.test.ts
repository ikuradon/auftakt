import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import { cachedBackend } from '../../src/backends/cached.js';
import { memoryBackend } from '../../src/backends/memory.js';
import type { StorageBackend, StoredEvent } from '../../src/backends/interface.js';
import type { NostrEvent } from '../../src/types.js';

const makeStored = (id: string, kind = 1): StoredEvent => ({
  event: { id, kind, pubkey: 'pk1', created_at: 1000, tags: [], content: '', sig: 's' } as NostrEvent,
  seenOn: ['wss://r1'],
  firstSeen: Date.now(),
  _tag_index: [],
  _d_tag: '',
});

/** Wraps a backend to count method calls */
function countingBackend(inner: StorageBackend) {
  let getCalls = 0;
  let queryCalls = 0;
  return {
    ...inner,
    get getCalls() { return getCalls; },
    get queryCalls() { return queryCalls; },
    async get(...args: Parameters<StorageBackend['get']>) {
      getCalls++;
      return inner.get(...args);
    },
    async query(...args: Parameters<StorageBackend['query']>) {
      queryCalls++;
      return inner.query(...args);
    },
  };
}

describe('cachedBackend', () => {
  it('write-through: put writes to both cache and inner', async () => {
    const inner = memoryBackend();
    const cached = cachedBackend(inner, { maxCached: 100 });

    await cached.put(makeStored('e1'));

    // Both inner and cache should have the event
    const fromCached = await cached.get('e1');
    const fromInner = await inner.get('e1');
    expect(fromCached?.event.id).toBe('e1');
    expect(fromInner?.event.id).toBe('e1');
  });

  it('read-through: get hits cache first, falls back to inner', async () => {
    const inner = countingBackend(memoryBackend());
    const cached = cachedBackend(inner as StorageBackend, { maxCached: 100 });

    // Put directly to inner (simulates pre-existing IDB data)
    await inner.put(makeStored('e1'));

    // First get — cache miss, reads from inner
    const result1 = await cached.get('e1');
    expect(result1?.event.id).toBe('e1');
    const firstGetCalls = inner.getCalls;

    // Second get — cache hit, should not read from inner
    const result2 = await cached.get('e1');
    expect(result2?.event.id).toBe('e1');
    expect(inner.getCalls).toBe(firstGetCalls); // no additional inner.get()
  });

  it('query always goes to inner backend', async () => {
    const inner = countingBackend(memoryBackend());
    const cached = cachedBackend(inner as StorageBackend, { maxCached: 100 });

    await cached.put(makeStored('e1'));
    await cached.put(makeStored('e2'));

    const beforeQuery = inner.queryCalls;
    await cached.query({ kinds: [1] });
    expect(inner.queryCalls).toBe(beforeQuery + 1);
  });

  it('query populates cache for future get()', async () => {
    const inner = countingBackend(memoryBackend());
    const cached = cachedBackend(inner as StorageBackend, { maxCached: 100 });

    await inner.put(makeStored('e1'));

    // Query inner
    await cached.query({ kinds: [1] });

    // Now get should hit cache
    const beforeGet = inner.getCalls;
    const result = await cached.get('e1');
    expect(result?.event.id).toBe('e1');
    expect(inner.getCalls).toBe(beforeGet); // cache hit
  });

  it('delete removes from both cache and inner', async () => {
    const inner = memoryBackend();
    const cached = cachedBackend(inner, { maxCached: 100 });

    await cached.put(makeStored('e1'));
    await cached.delete('e1');

    expect(await cached.get('e1')).toBeNull();
    expect(await inner.get('e1')).toBeNull();
  });

  it('respects maxCached for memory cache (LRU eviction from cache only)', async () => {
    const inner = memoryBackend();
    const cached = cachedBackend(inner, { maxCached: 3 });

    await cached.put(makeStored('e0'));
    await cached.put(makeStored('e1'));
    await cached.put(makeStored('e2'));
    await cached.put(makeStored('e3')); // should evict e0 from cache

    // e0 evicted from cache but still in inner
    const fromInner = await inner.get('e0');
    expect(fromInner?.event.id).toBe('e0');

    // get('e0') should read-through from inner
    const fromCached = await cached.get('e0');
    expect(fromCached?.event.id).toBe('e0');
  });

  it('getByReplaceableKey read-through', async () => {
    const inner = memoryBackend();
    const cached = cachedBackend(inner, { maxCached: 100 });

    await inner.put(makeStored('p1', 0));

    const result = await cached.getByReplaceableKey(0, 'pk1');
    expect(result?.event.id).toBe('p1');
  });

  it('getByAddressableKey read-through', async () => {
    const inner = memoryBackend();
    const cached = cachedBackend(inner, { maxCached: 100 });

    const stored = makeStored('a1', 30023);
    stored._d_tag = 'hello';
    await inner.put(stored);

    const result = await cached.getByAddressableKey(30023, 'pk1', 'hello');
    expect(result?.event.id).toBe('a1');
  });
});
