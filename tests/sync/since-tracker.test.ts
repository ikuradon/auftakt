import { describe, it, expect } from 'vitest';
import { createSinceTracker } from '../../src/sync/since-tracker.js';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import type { NostrEvent } from '../../src/types.js';

const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));

const makeEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
  id: 'e1', kind: 1, pubkey: 'pk1', created_at: 1000,
  tags: [], content: '', sig: 'sig1',
  ...overrides,
});

describe('SinceTracker', () => {
  it('returns undefined when store has no matching events', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const tracker = createSinceTracker(store);
    const since = await tracker.getSince({ kinds: [1] });
    expect(since).toBeUndefined();
  });

  it('returns latest created_at from cached events for the filter', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add(makeEvent({ id: 'a', kind: 1, created_at: 100 }));
    await store.add(makeEvent({ id: 'b', kind: 1, created_at: 300 }));
    await store.add(makeEvent({ id: 'c', kind: 1, created_at: 200 }));
    await wait();

    const tracker = createSinceTracker(store);
    const since = await tracker.getSince({ kinds: [1] });
    expect(since).toBe(300);
  });

  it('scopes to filter (different kinds have different since)', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add(makeEvent({ id: 'a', kind: 1, created_at: 100 }));
    await store.add(makeEvent({ id: 'b', kind: 7, created_at: 500 }));
    await wait();

    const tracker = createSinceTracker(store);
    expect(await tracker.getSince({ kinds: [1] })).toBe(100);
    expect(await tracker.getSince({ kinds: [7] })).toBe(500);
  });
});
