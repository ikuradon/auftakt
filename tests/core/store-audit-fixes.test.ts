import { describe, it, expect, vi } from 'vitest';
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

describe('audit fix: Kind 5 → Kind 5 deletion has no effect (NIP-09)', () => {
  it('does not delete a kind:5 event via e-tag of another kind:5', async () => {
    const store = createEventStore({ backend: memoryBackend() });

    // Store a kind:5 deletion event
    const kind5Event = makeEvent({
      id: 'del1',
      kind: 5,
      pubkey: 'pk1',
      created_at: 1000,
      tags: [['e', 'some-target']],
    });
    await store.add(kind5Event);

    // Another kind:5 targeting del1
    const kind5Delete = makeEvent({
      id: 'del2',
      kind: 5,
      pubkey: 'pk1',
      created_at: 2000,
      tags: [['e', 'del1']],
    });
    await store.add(kind5Delete);

    // del1 should still exist in the store
    const result = await store.getSync({ ids: ['del1'] });
    expect(result).toHaveLength(1);
    expect(result[0].event.id).toBe('del1');
  });
});

describe('audit fix: a-tag kind NaN validation', () => {
  it('ignores a-tag with non-numeric kind in kind:5 deletion', async () => {
    const store = createEventStore({ backend: memoryBackend() });

    // Store an addressable event
    await store.add(
      makeEvent({
        id: 'addr1',
        kind: 30023,
        pubkey: 'pk1',
        tags: [['d', 'slug']],
      }),
    );

    // kind:5 with malformed a-tag (non-numeric kind)
    const result = await store.add(
      makeEvent({
        id: 'del1',
        kind: 5,
        pubkey: 'pk1',
        created_at: 2000,
        tags: [['a', 'abc:pk1:slug']],
      }),
    );

    expect(result).toBe('added');
    // addr1 should NOT be deleted
    const remaining = await store.getSync({ ids: ['addr1'] });
    expect(remaining).toHaveLength(1);
  });

  it('ignores a-tag with empty kind string in kind:5 deletion', async () => {
    const store = createEventStore({ backend: memoryBackend() });

    await store.add(
      makeEvent({
        id: 'addr2',
        kind: 30023,
        pubkey: 'pk1',
        tags: [['d', 'test']],
      }),
    );

    await store.add(
      makeEvent({
        id: 'del2',
        kind: 5,
        pubkey: 'pk1',
        created_at: 2000,
        tags: [['a', ':pk1:test']],
      }),
    );

    const remaining = await store.getSync({ ids: ['addr2'] });
    expect(remaining).toHaveLength(1);
  });
});

describe('audit fix: Replaceable/Addressable replaced path checks pendingDeletions', () => {
  it('deletes a replaceable event that was pending deletion after replacement', async () => {
    const store = createEventStore({ backend: memoryBackend() });

    // kind:5 arrives first targeting 'repl-new' (future event)
    await store.add(
      makeEvent({
        id: 'del-repl',
        kind: 5,
        pubkey: 'pk1',
        created_at: 3000,
        tags: [['e', 'repl-new']],
      }),
    );

    // Old replaceable event
    await store.add(
      makeEvent({
        id: 'repl-old',
        kind: 0,
        pubkey: 'pk1',
        created_at: 1000,
      }),
    );

    // New replaceable that replaces old — but is marked deleted in backend
    // With backend-persisted deletion, event is rejected at step 1.5 (isDeleted check)
    // so the old replaceable event is NOT replaced
    const result = await store.add(
      makeEvent({
        id: 'repl-new',
        kind: 0,
        pubkey: 'pk1',
        created_at: 2000,
      }),
    );

    // Should be deleted (backend-persisted deletion applied at step 1.5)
    expect(result).toBe('deleted');
    // Old replaceable event remains since replacement was rejected
    const remaining = await store.getSync({ kinds: [0], authors: ['pk1'] });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].event.id).toBe('repl-old');
  });

  it('deletes an addressable event that was pending deletion after replacement', async () => {
    const store = createEventStore({ backend: memoryBackend() });

    // kind:5 arrives first targeting 'addr-new'
    await store.add(
      makeEvent({
        id: 'del-addr',
        kind: 5,
        pubkey: 'pk1',
        created_at: 3000,
        tags: [['e', 'addr-new']],
      }),
    );

    // Old addressable
    await store.add(
      makeEvent({
        id: 'addr-old',
        kind: 30023,
        pubkey: 'pk1',
        created_at: 1000,
        tags: [['d', 'slug']],
      }),
    );

    // New addressable that replaces old — but is marked deleted in backend
    // With backend-persisted deletion, event is rejected at step 1.5 (isDeleted check)
    // so the old addressable event is NOT replaced
    const result = await store.add(
      makeEvent({
        id: 'addr-new',
        kind: 30023,
        pubkey: 'pk1',
        created_at: 2000,
        tags: [['d', 'slug']],
      }),
    );

    expect(result).toBe('deleted');
    // Old addressable event remains since replacement was rejected
    const remaining = await store.getSync({ kinds: [30023], authors: ['pk1'] });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].event.id).toBe('addr-old');
  });
});

describe('audit fix: inflight dedup does not propagate AbortError to non-signal callers', () => {
  it('signal-bearing fetchById does not affect concurrent non-signal fetchById', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const controller = new AbortController();

    let resolveRelay: (v: { event: NostrEvent; relay: string } | null) => void;
    const fetchFn = vi.fn(
      () =>
        new Promise<{ event: NostrEvent; relay: string } | null>((resolve) => {
          resolveRelay = resolve;
        }),
    );

    // First call WITH signal
    const promise1 = store.fetchById('e1', {
      fetch: fetchFn,
      signal: controller.signal,
    });

    // Second call WITHOUT signal — should not be affected by first's abort
    const promise2 = store.fetchById('e1', {
      fetch: fetchFn,
    });

    // Abort the first call
    controller.abort();

    // promise1 should reject
    await expect(promise1).rejects.toThrow('Aborted');

    // Resolve the fetch for promise2
    resolveRelay!({ event: makeEvent(), relay: 'wss://relay1' });

    // promise2 should resolve successfully (not reject with AbortError)
    const result = await promise2;
    expect(result).not.toBeNull();
    expect(result!.event.id).toBe('e1');
  });
});
