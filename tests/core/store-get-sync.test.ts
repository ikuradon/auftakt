import { describe, it, expect } from 'vitest';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import type { NostrEvent } from '../../src/types.js';

const wait = (ms = 50) => new Promise(r => setTimeout(r, ms));

const makeEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
  id: 'e1', kind: 1, pubkey: 'pk1', created_at: 1000,
  tags: [], content: '', sig: 'sig1',
  ...overrides,
});

describe('store.getSync()', () => {
  it('returns cached events synchronously (Promise-based)', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add(makeEvent({ id: 'a', kind: 0, pubkey: 'pk1', created_at: 100 }));
    await store.add(makeEvent({ id: 'b', kind: 1, pubkey: 'pk1', created_at: 200 }));

    const profiles = await store.getSync({ kinds: [0], authors: ['pk1'] });
    expect(profiles).toHaveLength(1);
    expect(profiles[0].event.id).toBe('a');
  });

  it('returns empty array when no matches', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const result = await store.getSync({ kinds: [999] });
    expect(result).toHaveLength(0);
  });

  it('applies filter (since, until, limit)', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add(makeEvent({ id: 'a', created_at: 100 }));
    await store.add(makeEvent({ id: 'b', created_at: 200 }));
    await store.add(makeEvent({ id: 'c', created_at: 300 }));

    const result = await store.getSync({ since: 150, until: 250, limit: 10 });
    expect(result).toHaveLength(1);
    expect(result[0].event.id).toBe('b');
  });

  it('excludes deleted events', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add(makeEvent({ id: 'target', kind: 1, pubkey: 'pk1' }));
    await store.add(makeEvent({
      id: 'del', kind: 5, pubkey: 'pk1', tags: [['e', 'target']],
    }));

    const result = await store.getSync({ ids: ['target'] });
    expect(result).toHaveLength(0);
  });

  it('is non-reactive (returns snapshot, not Observable)', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const result = await store.getSync({ kinds: [1] });
    expect(Array.isArray(result)).toBe(true);
  });
});
