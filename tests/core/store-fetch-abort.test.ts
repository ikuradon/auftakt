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

describe('store.fetchById with AbortSignal', () => {
  it('rejects with AbortError when signal is aborted', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const controller = new AbortController();

    const fetchFn = vi.fn(
      () => new Promise<{ event: NostrEvent; relay: string } | null>((resolve) => {
        // Simulate slow relay
        setTimeout(() => resolve({ event: makeEvent(), relay: 'wss://relay1' }), 5000);
      }),
    );

    const promise = store.fetchById('e1', {
      fetch: fetchFn,
      signal: controller.signal,
    });

    controller.abort();

    await expect(promise).rejects.toThrow('Aborted');
    await expect(promise).rejects.toBeInstanceOf(DOMException);
  });

  it('rejects immediately if signal is already aborted', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const controller = new AbortController();
    controller.abort();

    const promise = store.fetchById('e1', {
      fetch: async () => ({ event: makeEvent(), relay: 'wss://relay1' }),
      signal: controller.signal,
    });

    await expect(promise).rejects.toThrow('Aborted');
  });

  it('returns normally if signal is not aborted', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const controller = new AbortController();

    const result = await store.fetchById('e1', {
      fetch: async () => ({ event: makeEvent(), relay: 'wss://relay1' }),
      signal: controller.signal,
    });

    expect(result).not.toBeNull();
    expect(result!.event.id).toBe('e1');
  });

  it('returns from cache without checking signal', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add(makeEvent({ id: 'cached1' }));

    const controller = new AbortController();
    // Signal not aborted, but even if it were, cache hit should still work
    const result = await store.fetchById('cached1', {
      signal: controller.signal,
    });

    expect(result).not.toBeNull();
    expect(result!.event.id).toBe('cached1');
  });
});
