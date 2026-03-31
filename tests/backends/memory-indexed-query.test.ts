import { describe, it, expect, beforeEach } from 'vitest';
import { memoryBackend } from '../../src/backends/memory.js';
import type { StorageBackend, StoredEvent } from '../../src/backends/interface.js';
import type { NostrEvent } from '../../src/types.js';

const baseEvent: NostrEvent = {
  id: 'e1',
  kind: 1,
  pubkey: 'pk1',
  created_at: 1000,
  tags: [],
  content: 'hello',
  sig: 'sig1',
};

const makeStored = (
  overrides: {
    event?: Partial<NostrEvent>;
    seenOn?: string[];
    _tag_index?: string[];
    _d_tag?: string;
  } = {},
): StoredEvent => ({
  event: { ...baseEvent, ...overrides.event } as NostrEvent,
  seenOn: overrides.seenOn ?? ['wss://relay1'],
  firstSeen: Date.now(),
  _tag_index: overrides._tag_index ?? [],
  _d_tag: overrides._d_tag ?? '',
});

describe('memoryBackend indexed query', () => {
  let backend: StorageBackend;

  beforeEach(() => {
    backend = memoryBackend();
  });

  it('queries by kinds using index', async () => {
    for (let i = 0; i < 100; i++) {
      await backend.put(makeStored({ event: { id: `k1-${i}`, kind: 1, created_at: i } }));
    }
    for (let i = 0; i < 10; i++) {
      await backend.put(makeStored({ event: { id: `k7-${i}`, kind: 7, created_at: i } }));
    }

    const results = await backend.query({ kinds: [7] });
    expect(results).toHaveLength(10);
    expect(results.every((r) => r.event.kind === 7)).toBe(true);
  });

  it('queries by authors using index', async () => {
    for (let i = 0; i < 50; i++) {
      await backend.put(makeStored({ event: { id: `a-${i}`, pubkey: 'pkA', created_at: i } }));
    }
    for (let i = 0; i < 50; i++) {
      await backend.put(makeStored({ event: { id: `b-${i}`, pubkey: 'pkB', created_at: i } }));
    }

    const results = await backend.query({ authors: ['pkB'] });
    expect(results).toHaveLength(50);
    expect(results.every((r) => r.event.pubkey === 'pkB')).toBe(true);
  });

  it('queries by kinds + authors (intersection)', async () => {
    await backend.put(makeStored({ event: { id: 'a', kind: 1, pubkey: 'pk1' } }));
    await backend.put(makeStored({ event: { id: 'b', kind: 1, pubkey: 'pk2' } }));
    await backend.put(makeStored({ event: { id: 'c', kind: 7, pubkey: 'pk1' } }));
    await backend.put(makeStored({ event: { id: 'd', kind: 7, pubkey: 'pk2' } }));

    const results = await backend.query({ kinds: [1], authors: ['pk2'] });
    expect(results).toHaveLength(1);
    expect(results[0].event.id).toBe('b');
  });

  it('queries with multiple kinds (union)', async () => {
    await backend.put(makeStored({ event: { id: 'a', kind: 0 } }));
    await backend.put(makeStored({ event: { id: 'b', kind: 1 } }));
    await backend.put(makeStored({ event: { id: 'c', kind: 3 } }));

    const results = await backend.query({ kinds: [0, 3] });
    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.event.id).sort();
    expect(ids).toEqual(['a', 'c']);
  });

  it('queries with multiple authors (union)', async () => {
    await backend.put(makeStored({ event: { id: 'a', pubkey: 'pk1' } }));
    await backend.put(makeStored({ event: { id: 'b', pubkey: 'pk2' } }));
    await backend.put(makeStored({ event: { id: 'c', pubkey: 'pk3' } }));

    const results = await backend.query({ authors: ['pk1', 'pk3'] });
    expect(results).toHaveLength(2);
  });

  it('index is maintained after delete', async () => {
    await backend.put(makeStored({ event: { id: 'a', kind: 1, pubkey: 'pk1' } }));
    await backend.put(makeStored({ event: { id: 'b', kind: 1, pubkey: 'pk1' } }));
    await backend.delete('a');

    const results = await backend.query({ kinds: [1] });
    expect(results).toHaveLength(1);
    expect(results[0].event.id).toBe('b');
  });

  it('index is maintained after clear', async () => {
    await backend.put(makeStored({ event: { id: 'a', kind: 1 } }));
    await backend.clear();
    const results = await backend.query({ kinds: [1] });
    expect(results).toHaveLength(0);
  });

  it('queries by author prefix (NIP-01)', async () => {
    await backend.put(
      makeStored({
        event: {
          id: 'a',
          pubkey: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        },
      }),
    );
    await backend.put(makeStored({ event: { id: 'b', pubkey: 'xxxxxx' } }));

    const results = await backend.query({ authors: ['abcdef'] });
    expect(results).toHaveLength(1);
    expect(results[0].event.id).toBe('a');
  });

  it('queries by kinds + author prefix (intersection)', async () => {
    await backend.put(
      makeStored({
        event: {
          id: 'a',
          kind: 1,
          pubkey: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        },
      }),
    );
    await backend.put(makeStored({ event: { id: 'b', kind: 1, pubkey: 'xxxxxx' } }));

    const results = await backend.query({ kinds: [1], authors: ['abcdef'] });
    expect(results).toHaveLength(1);
    expect(results[0].event.id).toBe('a');
  });

  it('handles overwrite of same event id', async () => {
    await backend.put(makeStored({ event: { id: 'a', kind: 1, pubkey: 'pk1' } }));
    // Overwrite with different seenOn
    await backend.put(
      makeStored({ event: { id: 'a', kind: 1, pubkey: 'pk1' }, seenOn: ['wss://relay2'] }),
    );

    const results = await backend.query({ kinds: [1] });
    expect(results).toHaveLength(1);
    expect(results[0].seenOn).toEqual(['wss://relay2']);
  });
});
