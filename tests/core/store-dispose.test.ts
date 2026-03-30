import { describe, it, expect } from 'vitest';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import type { NostrEvent } from '../../src/types.js';

const makeEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
  id: 'e1', kind: 1, pubkey: 'pk1', created_at: 1000,
  tags: [], content: '', sig: 'sig1',
  ...overrides,
});

describe('store.dispose()', () => {
  it('completes query subscribers on dispose', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add(makeEvent());

    let completed = false;
    const sub = store.query({ kinds: [1] }).subscribe({
      complete: () => { completed = true; },
    });

    store.dispose();
    expect(completed).toBe(true);
    sub.unsubscribe();
  });

  it('completes changes$ on dispose', async () => {
    const store = createEventStore({ backend: memoryBackend() });

    let completed = false;
    const sub = store.changes$.subscribe({
      complete: () => { completed = true; },
    });

    store.dispose();
    expect(completed).toBe(true);
    sub.unsubscribe();
  });

  it('completes multiple query subscribers on dispose', async () => {
    const store = createEventStore({ backend: memoryBackend() });

    let count = 0;
    const sub1 = store.query({ kinds: [1] }).subscribe({
      complete: () => { count++; },
    });
    const sub2 = store.query({ kinds: [7] }).subscribe({
      complete: () => { count++; },
    });

    store.dispose();
    expect(count).toBe(2);
    sub1.unsubscribe();
    sub2.unsubscribe();
  });
});
