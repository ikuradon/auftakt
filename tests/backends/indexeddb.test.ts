import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { indexedDBBackend } from '../../src/backends/indexeddb.js';
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
    _tag_index?: string[];
    _d_tag?: string;
  } = {},
): StoredEvent => ({
  event: { ...baseEvent, ...overrides.event } as NostrEvent,
  seenOn: ['wss://relay1'],
  firstSeen: Date.now(),
  _tag_index: overrides._tag_index ?? [],
  _d_tag: overrides._d_tag ?? '',
});

let dbCounter = 0;

describe('indexedDBBackend', () => {
  let backend: StorageBackend;

  beforeEach(() => {
    backend = indexedDBBackend(`test-db-${dbCounter++}`);
  });

  it('puts and gets by id', async () => {
    await backend.put(makeStored());
    const result = await backend.get('e1');
    expect(result?.event.id).toBe('e1');
  });

  it('returns null for missing id', async () => {
    expect(await backend.get('missing')).toBeNull();
  });

  it('deletes by id', async () => {
    await backend.put(makeStored());
    await backend.delete('e1');
    expect(await backend.get('e1')).toBeNull();
  });

  it('queries by kinds', async () => {
    await backend.put(makeStored({ event: { id: 'a', kind: 1 } }));
    await backend.put(makeStored({ event: { id: 'b', kind: 7 } }));
    const results = await backend.query({ kinds: [1] });
    expect(results).toHaveLength(1);
    expect(results[0].event.id).toBe('a');
  });

  it('queries by authors', async () => {
    await backend.put(makeStored({ event: { id: 'a', pubkey: 'pk1' } }));
    await backend.put(makeStored({ event: { id: 'b', pubkey: 'pk2' } }));
    const results = await backend.query({ authors: ['pk2'] });
    expect(results).toHaveLength(1);
    expect(results[0].event.id).toBe('b');
  });

  it('queries by tag index', async () => {
    await backend.put(
      makeStored({
        event: { id: 'a', tags: [['e', 'ref1']] },
        _tag_index: ['e:ref1'],
      }),
    );
    await backend.put(
      makeStored({
        event: { id: 'b', tags: [['e', 'ref2']] },
        _tag_index: ['e:ref2'],
      }),
    );
    const results = await backend.query({ '#e': ['ref1'] });
    expect(results).toHaveLength(1);
    expect(results[0].event.id).toBe('a');
  });

  it('applies limit with descending sort', async () => {
    for (let i = 0; i < 5; i++) {
      await backend.put(makeStored({ event: { id: `e${i}`, created_at: i * 100 } }));
    }
    const results = await backend.query({ limit: 2 });
    expect(results).toHaveLength(2);
    expect(results[0].event.created_at).toBeGreaterThan(results[1].event.created_at);
  });

  it('getByReplaceableKey works', async () => {
    await backend.put(makeStored({ event: { id: 'p1', kind: 0, pubkey: 'pk1' } }));
    const result = await backend.getByReplaceableKey(0, 'pk1');
    expect(result?.event.id).toBe('p1');
  });

  it('getByAddressableKey works', async () => {
    await backend.put(
      makeStored({
        event: { id: 'a1', kind: 30023, pubkey: 'pk1' },
        _d_tag: 'hello',
      }),
    );
    const result = await backend.getByAddressableKey(30023, 'pk1', 'hello');
    expect(result?.event.id).toBe('a1');
  });

  it('getAllEventIds returns all ids', async () => {
    await backend.put(makeStored({ event: { id: 'a' } }));
    await backend.put(makeStored({ event: { id: 'b' } }));
    const ids = await backend.getAllEventIds();
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  it('clear removes all', async () => {
    await backend.put(makeStored({ event: { id: 'a' } }));
    await backend.clear();
    expect(await backend.get('a')).toBeNull();
  });
});
