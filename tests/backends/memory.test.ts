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
): StoredEvent => {
  const event = { ...baseEvent, ...overrides.event } as NostrEvent;
  return {
    id: event.id,
    pubkey: event.pubkey,
    kind: event.kind,
    created_at: event.created_at,
    event,
    seenOn: overrides.seenOn ?? ['wss://relay1'],
    firstSeen: Date.now(),
    _tag_index: overrides._tag_index ?? [],
    _d_tag: overrides._d_tag ?? '',
  };
};

describe('memoryBackend', () => {
  let backend: StorageBackend;

  beforeEach(() => {
    backend = memoryBackend();
  });

  it('puts and gets by id', async () => {
    const stored = makeStored();
    await backend.put(stored);
    const result = await backend.get('e1');
    expect(result).toEqual(stored);
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

  it('queries with since/until', async () => {
    await backend.put(makeStored({ event: { id: 'a', created_at: 100 } }));
    await backend.put(makeStored({ event: { id: 'b', created_at: 200 } }));
    await backend.put(makeStored({ event: { id: 'c', created_at: 300 } }));
    const results = await backend.query({ since: 150, until: 250 });
    expect(results).toHaveLength(1);
    expect(results[0].event.id).toBe('b');
  });

  it('queries by tag index', async () => {
    await backend.put(
      makeStored({ event: { id: 'a', tags: [['e', 'ref1']] }, _tag_index: ['e:ref1'] }),
    );
    await backend.put(
      makeStored({ event: { id: 'b', tags: [['e', 'ref2']] }, _tag_index: ['e:ref2'] }),
    );
    const results = await backend.query({ '#e': ['ref1'] });
    expect(results).toHaveLength(1);
    expect(results[0].event.id).toBe('a');
  });

  it('applies limit and sorts by created_at desc', async () => {
    for (let i = 0; i < 10; i++) {
      await backend.put(makeStored({ event: { id: `e${i}`, created_at: i * 100 } }));
    }
    const results = await backend.query({ limit: 3 });
    expect(results).toHaveLength(3);
    expect(results[0].event.created_at).toBeGreaterThan(results[1].event.created_at);
  });

  it('getByReplaceableKey returns matching event', async () => {
    await backend.put(makeStored({ event: { id: 'profile1', kind: 0, pubkey: 'pk1' } }));
    const result = await backend.getByReplaceableKey(0, 'pk1');
    expect(result?.event.id).toBe('profile1');
  });

  it('getByAddressableKey returns matching event', async () => {
    await backend.put(
      makeStored({ event: { id: 'addr1', kind: 30023, pubkey: 'pk1' }, _d_tag: 'hello' }),
    );
    const result = await backend.getByAddressableKey(30023, 'pk1', 'hello');
    expect(result?.event.id).toBe('addr1');
  });

  it('getAllEventIds returns all ids', async () => {
    await backend.put(makeStored({ event: { id: 'a' } }));
    await backend.put(makeStored({ event: { id: 'b' } }));
    const ids = await backend.getAllEventIds();
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  it('clear removes all events', async () => {
    await backend.put(makeStored({ event: { id: 'a' } }));
    await backend.clear();
    expect(await backend.get('a')).toBeNull();
  });

  describe('count()', () => {
    it('counts matching events', async () => {
      await backend.put(makeStored({ event: { id: 'a', kind: 1 } }));
      await backend.put(makeStored({ event: { id: 'b', kind: 1 } }));
      await backend.put(makeStored({ event: { id: 'c', kind: 7 } }));
      expect(await backend.count({ kinds: [1] })).toBe(2);
    });

    it('returns 0 for no matches', async () => {
      expect(await backend.count({ kinds: [999] })).toBe(0);
    });
  });

  describe('markDeleted / isDeleted', () => {
    it('marks an event as deleted and checks', async () => {
      await backend.markDeleted('e1', 'pk1', 1000);
      expect(await backend.isDeleted('e1')).toBe(true);
    });

    it('returns false for non-deleted event', async () => {
      expect(await backend.isDeleted('e1')).toBe(false);
    });

    it('checks pubkey match when provided', async () => {
      await backend.markDeleted('e1', 'pk1', 1000);
      expect(await backend.isDeleted('e1', 'pk1')).toBe(true);
      expect(await backend.isDeleted('e1', 'pk2')).toBe(false);
    });

    it('empty deletedBy matches any pubkey', async () => {
      await backend.markDeleted('e1', '', 0);
      expect(await backend.isDeleted('e1', 'pk1')).toBe(true);
      expect(await backend.isDeleted('e1', 'pk2')).toBe(true);
    });

    it('clear removes deleted records', async () => {
      await backend.markDeleted('e1', 'pk1', 1000);
      await backend.clear();
      expect(await backend.isDeleted('e1')).toBe(false);
    });
  });

  describe('markReplaceDeletion / getReplaceDeletion', () => {
    it('stores and retrieves replace deletion record', async () => {
      await backend.markReplaceDeletion('hash1', 'pk1', 2000);
      const record = await backend.getReplaceDeletion('hash1');
      expect(record).toEqual({ aTagHash: 'hash1', deletedBy: 'pk1', deletedAt: 2000 });
    });

    it('returns null for non-existent hash', async () => {
      expect(await backend.getReplaceDeletion('missing')).toBeNull();
    });

    it('updates to newer deletedAt only', async () => {
      await backend.markReplaceDeletion('hash1', 'pk1', 2000);
      await backend.markReplaceDeletion('hash1', 'pk1', 1000); // older, should not update
      const record = await backend.getReplaceDeletion('hash1');
      expect(record!.deletedAt).toBe(2000);
    });

    it('updates when newer', async () => {
      await backend.markReplaceDeletion('hash1', 'pk1', 1000);
      await backend.markReplaceDeletion('hash1', 'pk1', 3000);
      const record = await backend.getReplaceDeletion('hash1');
      expect(record!.deletedAt).toBe(3000);
    });

    it('clear removes replace deletion records', async () => {
      await backend.markReplaceDeletion('hash1', 'pk1', 2000);
      await backend.clear();
      expect(await backend.getReplaceDeletion('hash1')).toBeNull();
    });
  });

  describe('setNegative / isNegative / cleanExpiredNegative', () => {
    it('sets and checks negative cache', async () => {
      await backend.setNegative('e1', 60_000);
      expect(await backend.isNegative('e1')).toBe(true);
    });

    it('returns false for non-existent entry', async () => {
      expect(await backend.isNegative('e1')).toBe(false);
    });

    it('returns false for expired entry', async () => {
      await backend.setNegative('e1', -1); // already expired
      expect(await backend.isNegative('e1')).toBe(false);
    });

    it('cleanExpiredNegative removes expired entries', async () => {
      await backend.setNegative('e1', -1); // already expired
      await backend.setNegative('e2', 60_000); // still valid
      await backend.cleanExpiredNegative();
      // e1 should be cleaned (isNegative already removes on check, but cleanExpiredNegative batch cleans)
      expect(await backend.isNegative('e2')).toBe(true);
    });

    it('clear removes negative cache', async () => {
      await backend.setNegative('e1', 60_000);
      await backend.clear();
      expect(await backend.isNegative('e1')).toBe(false);
    });
  });
});
