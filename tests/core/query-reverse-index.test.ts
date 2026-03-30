import { describe, it, expect, vi } from 'vitest';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import type { NostrEvent } from '../../src/types.js';

const wait = (ms = 50) => new Promise(r => setTimeout(r, ms));

const makeEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
  id: 'e1', kind: 1, pubkey: 'pk1', created_at: 1000,
  tags: [], content: '', sig: 'sig1',
  ...overrides,
});

describe('query reverse index optimization', () => {
  it('only notifies queries matching added event kind', async () => {
    const store = createEventStore({ backend: memoryBackend() });

    const kind1Updates: number[] = [];
    const kind7Updates: number[] = [];

    const sub1 = store.query({ kinds: [1] }).subscribe(e => kind1Updates.push(e.length));
    const sub7 = store.query({ kinds: [7] }).subscribe(e => kind7Updates.push(e.length));
    await wait();

    const before1 = kind1Updates.length;
    const before7 = kind7Updates.length;

    // Add kind:1 event — should notify kind:1 query but NOT kind:7
    await store.add(makeEvent({ id: 'note1', kind: 1 }));
    await wait();

    expect(kind1Updates.length).toBeGreaterThan(before1);
    // kind:7 should NOT have received additional updates
    expect(kind7Updates.length).toBe(before7);

    sub1.unsubscribe();
    sub7.unsubscribe();
  });

  it('notifies wildcard queries (no kinds/authors) for any event', async () => {
    const store = createEventStore({ backend: memoryBackend() });

    const allUpdates: number[] = [];
    const sub = store.query({}).subscribe(e => allUpdates.push(e.length));
    await wait();

    const before = allUpdates.length;
    await store.add(makeEvent({ id: 'any1', kind: 42 }));
    await wait();

    expect(allUpdates.length).toBeGreaterThan(before);

    sub.unsubscribe();
  });

  it('deletion only notifies queries that could contain the deleted event', async () => {
    const store = createEventStore({ backend: memoryBackend() });

    await store.add(makeEvent({ id: 'target', kind: 1, pubkey: 'pk1' }));
    await wait();

    const kind1Updates: number[] = [];
    const kind7Updates: number[] = [];

    const sub1 = store.query({ kinds: [1] }).subscribe(e => kind1Updates.push(e.length));
    const sub7 = store.query({ kinds: [7] }).subscribe(e => kind7Updates.push(e.length));
    await wait();

    const before7 = kind7Updates.length;

    // Delete kind:1 event
    await store.add(makeEvent({
      id: 'del1', kind: 5, pubkey: 'pk1',
      tags: [['e', 'target']],
    }));
    await wait();

    // kind:7 query should NOT be notified about a kind:1 deletion
    expect(kind7Updates.length).toBe(before7);

    sub1.unsubscribe();
    sub7.unsubscribe();
  });
});
