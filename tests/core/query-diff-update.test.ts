import { describe, it, expect } from 'vitest';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import type { StorageBackend } from '../../src/backends/interface.js';
import type { NostrEvent } from '../../src/types.js';

const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));

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

/** Wraps a backend to count query() calls */
function countingBackend(inner: StorageBackend): StorageBackend & { queryCount: number } {
  let queryCount = 0;
  return {
    ...inner,
    get queryCount() {
      return queryCount;
    },
    async query(...args: Parameters<StorageBackend['query']>) {
      queryCount++;
      return inner.query(...args);
    },
  };
}

describe('differential query update', () => {
  it('updates query result without full backend scan on regular add', async () => {
    const backend = countingBackend(memoryBackend());
    const store = createEventStore({ backend });

    const collected: number[] = [];
    const sub = store.query({ kinds: [1] }).subscribe((e) => collected.push(e.length));
    await wait();

    const initialCalls = backend.queryCount;

    await store.add(makeEvent({ id: 'a', kind: 1, created_at: 100 }));
    await wait();

    // Diff update should avoid backend.query()
    expect(backend.queryCount).toBe(initialCalls);
    expect(collected[collected.length - 1]).toBe(1);

    sub.unsubscribe();
  });

  it('falls back to full query on deletion', async () => {
    const backend = countingBackend(memoryBackend());
    const store = createEventStore({ backend });

    await store.add(makeEvent({ id: 'target', kind: 1, pubkey: 'pk1' }));

    const sub = store.query({ kinds: [1] }).subscribe(() => {});
    await wait();
    const beforeDelete = backend.queryCount;

    await store.add(
      makeEvent({
        id: 'del1',
        kind: 5,
        pubkey: 'pk1',
        tags: [['e', 'target']],
      }),
    );
    await wait();

    expect(backend.queryCount).toBeGreaterThan(beforeDelete);
    sub.unsubscribe();
  });

  it('falls back to full query on replaceable update', async () => {
    const backend = countingBackend(memoryBackend());
    const store = createEventStore({ backend });

    await store.add(makeEvent({ id: 'old', kind: 0, pubkey: 'pk1', created_at: 100 }));

    const sub = store.query({ kinds: [0] }).subscribe(() => {});
    await wait();
    const beforeReplace = backend.queryCount;

    await store.add(makeEvent({ id: 'new', kind: 0, pubkey: 'pk1', created_at: 200 }));
    await wait();

    expect(backend.queryCount).toBeGreaterThan(beforeReplace);
    sub.unsubscribe();
  });

  it('respects limit when inserting via diff', async () => {
    const store = createEventStore({ backend: memoryBackend() });

    for (let i = 0; i < 5; i++) {
      await store.add(makeEvent({ id: `e${i}`, kind: 1, created_at: i * 100 }));
    }
    await wait();

    const collected: number[] = [];
    const sub = store.query({ kinds: [1], limit: 3 }).subscribe((e) => collected.push(e.length));
    await wait();

    await store.add(makeEvent({ id: 'new1', kind: 1, created_at: 999 }));
    await wait();

    expect(collected.every((n) => n <= 3)).toBe(true);
    sub.unsubscribe();
  });
});
