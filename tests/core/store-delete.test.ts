import { describe, it, expect } from 'vitest';
import { firstValueFrom, skip } from 'rxjs';
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

const flush = () => new Promise((r) => setTimeout(r, 20));

describe('store.delete()', () => {
  it('removes an event from the store', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add(makeEvent({ id: 'target1' }));

    await store.delete('target1');

    const events = await store.getSync({ ids: ['target1'] });
    expect(events).toHaveLength(0);
  });

  it('marks event as deleted so re-add returns deleted', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add(makeEvent({ id: 'target1' }));

    await store.delete('target1');

    const result = await store.add(makeEvent({ id: 'target1' }));
    expect(result).toBe('deleted');
  });

  it('emits deleted change event', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add(makeEvent({ id: 'target1' }));

    const changePromise = firstValueFrom(store.changes$.pipe(skip(0)));
    await store.delete('target1');
    const change = await changePromise;

    expect(change.type).toBe('deleted');
    expect(change.event.id).toBe('target1');
  });

  it('updates reactive queries after delete', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add(makeEvent({ id: 'a', kind: 1 }));
    await store.add(makeEvent({ id: 'b', kind: 1, created_at: 2000 }));
    await flush();

    // Collect emissions
    const emissions: number[] = [];
    const sub = store.query({ kinds: [1] }).subscribe((events) => {
      emissions.push(events.length);
    });

    await flush(); // initial load: 2 events

    await store.delete('a');
    await flush(); // after delete: 1 event

    sub.unsubscribe();

    // Last emission should be 1
    expect(emissions[emissions.length - 1]).toBe(1);
  });

  it('is a no-op for non-existent event', async () => {
    const store = createEventStore({ backend: memoryBackend() });

    // Should not throw
    await store.delete('nonexistent');

    // But should still mark as deleted
    const result = await store.add(makeEvent({ id: 'nonexistent' }));
    expect(result).toBe('deleted');
  });
});
