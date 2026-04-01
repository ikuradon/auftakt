import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { dexieBackend } from '../../src/backends/dexie.js';
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

const uniqueDbName = () => `dexie-test-${Date.now()}-${Math.random()}`;

describe('dexieBackend', () => {
  let backend: StorageBackend;

  beforeEach(() => {
    backend = dexieBackend({ dbName: uniqueDbName() });
  });

  afterEach(async () => {
    await backend.dispose?.();
  });

  describe('Core CRUD', () => {
    it('puts and gets by id', async () => {
      const stored = makeStored();
      await backend.put(stored);
      const result = await backend.get('e1');
      expect(result?.id).toBe('e1');
      expect(result?.event.content).toBe('hello');
    });

    it('returns null for missing id', async () => {
      expect(await backend.get('missing')).toBeNull();
    });

    it('deletes by id', async () => {
      await backend.put(makeStored());
      await backend.delete('e1');
      expect(await backend.get('e1')).toBeNull();
    });
  });

  describe('getByReplaceableKey', () => {
    it('finds replaceable event by kind+pubkey', async () => {
      await backend.put(makeStored({ event: { id: 'p1', kind: 0, pubkey: 'pk1' } }));
      const result = await backend.getByReplaceableKey(0, 'pk1');
      expect(result?.id).toBe('p1');
    });

    it('returns null when no match', async () => {
      expect(await backend.getByReplaceableKey(0, 'pk999')).toBeNull();
    });
  });

  describe('getByAddressableKey', () => {
    it('finds addressable event by kind+pubkey+dTag', async () => {
      await backend.put(
        makeStored({
          event: { id: 'a1', kind: 30023, pubkey: 'pk1' },
          _d_tag: 'hello',
        }),
      );
      const result = await backend.getByAddressableKey(30023, 'pk1', 'hello');
      expect(result?.id).toBe('a1');
    });

    it('returns null when no match', async () => {
      expect(await backend.getByAddressableKey(30023, 'pk1', 'nope')).toBeNull();
    });
  });

  describe('getAllEventIds', () => {
    it('returns all ids', async () => {
      await backend.put(makeStored({ event: { id: 'a' } }));
      await backend.put(makeStored({ event: { id: 'b' } }));
      const ids = await backend.getAllEventIds();
      expect(ids.sort()).toEqual(['a', 'b']);
    });

    it('returns empty array when no events', async () => {
      expect(await backend.getAllEventIds()).toEqual([]);
    });
  });

  describe('clear', () => {
    it('removes all events', async () => {
      await backend.put(makeStored({ event: { id: 'a' } }));
      await backend.put(makeStored({ event: { id: 'b' } }));
      await backend.clear();
      expect(await backend.get('a')).toBeNull();
      expect(await backend.get('b')).toBeNull();
      expect(await backend.getAllEventIds()).toEqual([]);
    });

    it('clears deletion and negative cache too', async () => {
      await backend.markDeleted('e1', 'pk1', 1000);
      await backend.setNegative('e2', 60000);
      await backend.clear();
      expect(await backend.isDeleted('e1')).toBe(false);
      expect(await backend.isNegative('e2')).toBe(false);
    });
  });

  describe('Deletion tracking', () => {
    it('markDeleted/isDeleted round-trip', async () => {
      await backend.markDeleted('e1', 'pk1', 1000);
      expect(await backend.isDeleted('e1')).toBe(true);
    });

    it('isDeleted returns false for unknown event', async () => {
      expect(await backend.isDeleted('missing')).toBe(false);
    });

    it('isDeleted with pubkey check: same pubkey returns true', async () => {
      await backend.markDeleted('e1', 'pk1', 1000);
      expect(await backend.isDeleted('e1', 'pk1')).toBe(true);
    });

    it('isDeleted with pubkey check: different pubkey returns false', async () => {
      await backend.markDeleted('e1', 'pk1', 1000);
      expect(await backend.isDeleted('e1', 'pk2')).toBe(false);
    });

    it('isDeleted with empty deletedBy matches any pubkey', async () => {
      await backend.markDeleted('e1', '', 1000);
      expect(await backend.isDeleted('e1', 'pk1')).toBe(true);
      expect(await backend.isDeleted('e1', 'pk2')).toBe(true);
    });
  });

  describe('Replace deletion', () => {
    it('markReplaceDeletion/getReplaceDeletion round-trip', async () => {
      await backend.markReplaceDeletion('hash1', 'pk1', 1000);
      const record = await backend.getReplaceDeletion('hash1');
      expect(record).toEqual({ aTagHash: 'hash1', deletedBy: 'pk1', deletedAt: 1000 });
    });

    it('returns null for unknown aTagHash', async () => {
      expect(await backend.getReplaceDeletion('missing')).toBeNull();
    });

    it('keeps record with latest deletedAt', async () => {
      await backend.markReplaceDeletion('hash1', 'pk1', 1000);
      await backend.markReplaceDeletion('hash1', 'pk1', 2000);
      const record = await backend.getReplaceDeletion('hash1');
      expect(record?.deletedAt).toBe(2000);
    });

    it('does not overwrite with older deletedAt', async () => {
      await backend.markReplaceDeletion('hash1', 'pk1', 2000);
      await backend.markReplaceDeletion('hash1', 'pk1', 1000);
      const record = await backend.getReplaceDeletion('hash1');
      expect(record?.deletedAt).toBe(2000);
    });
  });

  describe('Negative cache', () => {
    it('setNegative/isNegative round-trip', async () => {
      await backend.setNegative('e1', 60000);
      expect(await backend.isNegative('e1')).toBe(true);
    });

    it('returns false for unknown event', async () => {
      expect(await backend.isNegative('missing')).toBe(false);
    });

    it('expired entry returns false', async () => {
      // Use TTL of 1ms so it expires almost immediately
      await backend.setNegative('e1', 1);
      // Small delay to ensure expiration
      await new Promise((r) => setTimeout(r, 10));
      expect(await backend.isNegative('e1')).toBe(false);
    });

    it('cleanExpiredNegative removes expired entries', async () => {
      await backend.setNegative('e1', 1);
      await backend.setNegative('e2', 60000);
      await new Promise((r) => setTimeout(r, 10));
      await backend.cleanExpiredNegative();
      expect(await backend.isNegative('e1')).toBe(false);
      expect(await backend.isNegative('e2')).toBe(true);
    });
  });

  describe('count', () => {
    it('counts matching events', async () => {
      await backend.put(makeStored({ event: { id: 'a', kind: 1 } }));
      await backend.put(makeStored({ event: { id: 'b', kind: 7 } }));
      await backend.put(makeStored({ event: { id: 'c', kind: 1 } }));
      expect(await backend.count({ kinds: [1] })).toBe(2);
    });

    it('counts all when empty filter', async () => {
      await backend.put(makeStored({ event: { id: 'a' } }));
      await backend.put(makeStored({ event: { id: 'b' } }));
      expect(await backend.count({})).toBe(2);
    });
  });
});
