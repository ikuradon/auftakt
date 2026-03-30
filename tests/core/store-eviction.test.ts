import { describe, it, expect } from 'vitest';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import { firstValueFrom, filter } from 'rxjs';
import type { NostrEvent, CachedEvent } from '../../src/types.js';

const wait = (ms = 50) => new Promise(r => setTimeout(r, ms));

const makeEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
  id: 'e1', kind: 1, pubkey: 'pk1', created_at: 1000,
  tags: [], content: '', sig: 'sig1',
  ...overrides,
});

describe('store with LRU eviction', () => {
  it('evicts old events when maxEvents exceeded', async () => {
    const store = createEventStore({
      backend: memoryBackend({ maxEvents: 3 }),
    });

    await store.add(makeEvent({ id: 'e0', created_at: 100 }));
    await store.add(makeEvent({ id: 'e1', created_at: 200 }));
    await store.add(makeEvent({ id: 'e2', created_at: 300 }));
    await store.add(makeEvent({ id: 'e3', created_at: 400 }));
    await wait();

    // e0 should be evicted (oldest access)
    const result = await store.fetchById('e0');
    expect(result).toBeNull();

    // e3 should exist
    const result3 = await store.fetchById('e3');
    expect(result3).not.toBeNull();
  });

  it('does not evict events in active query results (pinned)', async () => {
    const store = createEventStore({
      backend: memoryBackend({ maxEvents: 3 }),
    });

    await store.add(makeEvent({ id: 'e0', kind: 1, created_at: 100 }));
    await store.add(makeEvent({ id: 'e1', kind: 1, created_at: 200 }));
    await store.add(makeEvent({ id: 'e2', kind: 7, created_at: 300 }));

    // Create active query for kind:1 — pins e0 and e1
    const sub = store.query({ kinds: [1] }).subscribe(() => {});
    await wait();

    // Add event — should evict e2 (not pinned), not e0/e1
    await store.add(makeEvent({ id: 'e3', kind: 1, created_at: 400 }));

    const e0 = await store.fetchById('e0');
    const e2 = await store.fetchById('e2');
    expect(e0).not.toBeNull(); // pinned by active query
    expect(e2).toBeNull(); // evicted

    sub.unsubscribe();
  });
});
