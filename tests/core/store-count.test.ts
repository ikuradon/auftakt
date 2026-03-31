import { describe, it, expect } from 'vitest';
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

describe('store.count()', () => {
  it('returns 0 for empty store', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const count = await store.count({ kinds: [1] });
    expect(count).toBe(0);
  });

  it('counts matching events by kind', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add(makeEvent({ id: 'a', kind: 1 }));
    await store.add(makeEvent({ id: 'b', kind: 1 }));
    await store.add(makeEvent({ id: 'c', kind: 7 }));

    expect(await store.count({ kinds: [1] })).toBe(2);
    expect(await store.count({ kinds: [7] })).toBe(1);
    expect(await store.count({ kinds: [1, 7] })).toBe(3);
  });

  it('counts matching events by authors', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add(makeEvent({ id: 'a', pubkey: 'pk1' }));
    await store.add(makeEvent({ id: 'b', pubkey: 'pk2' }));

    expect(await store.count({ authors: ['pk1'] })).toBe(1);
  });

  it('counts with tag filter', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add(makeEvent({ id: 'a', tags: [['e', 'ref1']] }));
    await store.add(makeEvent({ id: 'b', tags: [['e', 'ref2']] }));
    await store.add(makeEvent({ id: 'c', tags: [['e', 'ref1']] }));

    expect(await store.count({ '#e': ['ref1'] })).toBe(2);
  });

  it('excludes deleted events', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add(makeEvent({ id: 'a', kind: 1 }));
    await store.add(makeEvent({ id: 'b', kind: 1 }));
    await store.delete('a');

    expect(await store.count({ kinds: [1] })).toBe(1);
  });

  it('excludes expired events', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add(makeEvent({ id: 'a', kind: 1 }));
    await store.add(makeEvent({ id: 'b', kind: 1, tags: [['expiration', '1']] }));

    // 'b' is expired (expiration=1 is in the past), but it was rejected at add time
    // so count should be 1
    expect(await store.count({ kinds: [1] })).toBe(1);
  });

  it('counts all when filter is empty', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add(makeEvent({ id: 'a', kind: 1 }));
    await store.add(makeEvent({ id: 'b', kind: 7 }));
    await store.add(makeEvent({ id: 'c', kind: 30023 }));

    expect(await store.count({})).toBe(3);
  });

  it('ignores limit in filter (counts all matches)', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    for (let i = 0; i < 10; i++) {
      await store.add(makeEvent({ id: `e${i}`, kind: 1, created_at: i }));
    }

    // limit should be ignored for count
    expect(await store.count({ kinds: [1], limit: 3 })).toBe(10);
  });
});
