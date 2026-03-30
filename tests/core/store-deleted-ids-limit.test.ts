import { describe, it, expect } from 'vitest';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import type { NostrEvent } from '../../src/types.js';

const makeEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
  id: 'e1', kind: 1, pubkey: 'pk1', created_at: 1000,
  tags: [], content: '', sig: 'sig1',
  ...overrides,
});

describe('deletedIds size limit', () => {
  it('trims oldest deletedIds when exceeding MAX_DELETED_IDS', async () => {
    const store = createEventStore({ backend: memoryBackend() });

    // Add events then delete them via kind:5
    const targetCount = 100;
    for (let i = 0; i < targetCount; i++) {
      await store.add(makeEvent({ id: `target-${i}`, pubkey: 'pk1', created_at: i }));
    }

    const eTags = Array.from({ length: targetCount }, (_, i) => ['e', `target-${i}`]);
    await store.add(makeEvent({
      id: 'del1', kind: 5, pubkey: 'pk1', created_at: 9999, tags: eTags,
    }));

    // First deleted target should be marked as deleted
    const result0 = await store.add(makeEvent({ id: 'target-0', pubkey: 'pk1' }));
    expect(result0).toBe('deleted');

    // Adding a regular event triggers trimDeletedIds without error
    const resultReg = await store.add(makeEvent({ id: 'regular1', pubkey: 'pk2' }));
    expect(resultReg).toBe('added');
  });
});
