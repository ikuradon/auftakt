import { describe, it, expect, vi } from 'vitest';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import type { NostrEvent } from '../../src/types.js';
import type { StorageBackend } from '../../src/backends/interface.js';

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

function spyBackend(): StorageBackend & { deleteCalls: string[] } {
  const inner = memoryBackend();
  const deleteCalls: string[] = [];
  return {
    ...inner,
    async delete(eventId: string) {
      deleteCalls.push(eventId);
      return inner.delete(eventId);
    },
    deleteCalls,
  } as StorageBackend & { deleteCalls: string[] };
}

describe('kind:5 deletion calls backend.delete()', () => {
  it('e-tag deletion removes target from backend', async () => {
    const backend = spyBackend();
    const store = createEventStore({ backend });

    await store.add(makeEvent({ id: 'target1', kind: 1, pubkey: 'pk1' }));

    await store.add(
      makeEvent({
        id: 'del1',
        kind: 5,
        pubkey: 'pk1',
        created_at: 2000,
        tags: [['e', 'target1']],
      }),
    );

    expect(backend.deleteCalls).toContain('target1');
    // Verify event is actually gone from backend
    const stored = await backend.get('target1');
    expect(stored).toBeNull();
  });

  it('a-tag deletion removes target from backend', async () => {
    const backend = spyBackend();
    const store = createEventStore({ backend });

    await store.add(
      makeEvent({
        id: 'addr1',
        kind: 30023,
        pubkey: 'pk1',
        tags: [['d', 'slug']],
      }),
    );

    await store.add(
      makeEvent({
        id: 'del2',
        kind: 5,
        pubkey: 'pk1',
        created_at: 2000,
        tags: [['a', '30023:pk1:slug']],
      }),
    );

    expect(backend.deleteCalls).toContain('addr1');
    const stored = await backend.get('addr1');
    expect(stored).toBeNull();
  });

  it('pendingDeletions path rejects target at step 1.5 via backend.isDeleted', async () => {
    const backend = spyBackend();
    const store = createEventStore({ backend });

    // kind:5 arrives BEFORE target
    await store.add(
      makeEvent({
        id: 'del3',
        kind: 5,
        pubkey: 'pk1',
        created_at: 2000,
        tags: [['e', 'future-target']],
      }),
    );

    // Target arrives later — rejected at step 1.5 (isDeleted returns true)
    const result = await store.add(
      makeEvent({ id: 'future-target', kind: 1, pubkey: 'pk1', created_at: 1000 }),
    );

    expect(result).toBe('deleted');
    // Event was never stored, so backend.delete was not called for it
    const stored = await backend.get('future-target');
    expect(stored).toBeNull();
  });
});
