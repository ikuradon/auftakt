import { describe, it, expect, beforeEach } from 'vitest';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import type { NostrEvent } from '../../src/types.js';

const makeEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
  id: 'e1', kind: 1, pubkey: 'pk1', created_at: 1000,
  tags: [], content: 'hello', sig: 'sig1',
  ...overrides,
});

describe('store.add() validation', () => {
  let store: ReturnType<typeof createEventStore>;

  beforeEach(() => {
    store = createEventStore({ backend: memoryBackend() });
  });

  it('rejects event with non-string id', async () => {
    const result = await store.add({ ...makeEvent(), id: 123 as any });
    expect(result).toBe('rejected');
  });

  it('rejects event with non-string pubkey', async () => {
    const result = await store.add({ ...makeEvent(), pubkey: null as any });
    expect(result).toBe('rejected');
  });

  it('rejects event with non-integer kind', async () => {
    const result = await store.add({ ...makeEvent(), kind: 1.5 });
    expect(result).toBe('rejected');
  });

  it('rejects event with non-number kind', async () => {
    const result = await store.add({ ...makeEvent(), kind: '1' as any });
    expect(result).toBe('rejected');
  });

  it('rejects event with non-number created_at', async () => {
    const result = await store.add({ ...makeEvent(), created_at: '1000' as any });
    expect(result).toBe('rejected');
  });

  it('rejects event with non-array tags', async () => {
    const result = await store.add({ ...makeEvent(), tags: 'bad' as any });
    expect(result).toBe('rejected');
  });

  it('rejects event with non-string content', async () => {
    const result = await store.add({ ...makeEvent(), content: 42 as any });
    expect(result).toBe('rejected');
  });

  it('rejects event with non-string sig', async () => {
    const result = await store.add({ ...makeEvent(), sig: undefined as any });
    expect(result).toBe('rejected');
  });

  it('accepts valid event', async () => {
    const result = await store.add(makeEvent());
    expect(result).toBe('added');
  });
});

describe('store.add() maxEventSize', () => {
  it('rejects events exceeding maxEventSize', async () => {
    const store = createEventStore({
      backend: memoryBackend(),
      maxEventSize: 100,
    });
    const bigContent = 'x'.repeat(200);
    const result = await store.add(makeEvent({ content: bigContent }));
    expect(result).toBe('rejected');
  });

  it('allows events within maxEventSize', async () => {
    const store = createEventStore({
      backend: memoryBackend(),
      maxEventSize: 10000,
    });
    const result = await store.add(makeEvent());
    expect(result).toBe('added');
  });

  it('allows any size when maxEventSize is not set', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const bigContent = 'x'.repeat(100000);
    const result = await store.add(makeEvent({ id: 'big1', content: bigContent }));
    expect(result).toBe('added');
  });
});
