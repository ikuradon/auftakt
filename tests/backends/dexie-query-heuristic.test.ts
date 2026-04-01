import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { dexieBackend } from '../../src/backends/dexie.js';
import type { StorageBackend, StoredEvent } from '../../src/backends/interface.js';
import type { NostrEvent } from '../../src/types.js';

const baseEvent: NostrEvent = {
  id: 'e1',
  kind: 1,
  pubkey: 'a'.repeat(64),
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

const uniqueDbName = () => `dexie-heuristic-${Date.now()}-${Math.random()}`;

describe('dexieBackend query heuristic', () => {
  let backend: StorageBackend;

  beforeEach(() => {
    backend = dexieBackend({ dbName: uniqueDbName() });
  });

  afterEach(async () => {
    await backend.dispose?.();
  });

  describe('Priority 1: ids filter', () => {
    it('returns events matching ids', async () => {
      await backend.put(makeStored({ event: { id: 'e1' } }));
      await backend.put(makeStored({ event: { id: 'e2' } }));
      await backend.put(makeStored({ event: { id: 'e3' } }));
      const results = await backend.query({ ids: ['e1', 'e3'] });
      expect(results.map((r) => r.id).sort()).toEqual(['e1', 'e3']);
    });

    it('returns empty for non-matching ids', async () => {
      await backend.put(makeStored({ event: { id: 'e1' } }));
      const results = await backend.query({ ids: ['missing'] });
      expect(results).toEqual([]);
    });
  });

  describe('Priority 2: tag filter', () => {
    it('queries by #p tag', async () => {
      const pk = 'b'.repeat(64);
      await backend.put(
        makeStored({
          event: { id: 'e1', tags: [['p', pk]] },
          _tag_index: [`p:${pk}`],
        }),
      );
      await backend.put(
        makeStored({
          event: { id: 'e2', tags: [] },
        }),
      );
      const results = await backend.query({ '#p': [pk] });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('e1');
    });

    it('queries by #t tag', async () => {
      await backend.put(
        makeStored({
          event: { id: 'e1', tags: [['t', 'nostr']] },
          _tag_index: ['t:nostr'],
        }),
      );
      await backend.put(
        makeStored({
          event: { id: 'e2', tags: [['t', 'bitcoin']] },
          _tag_index: ['t:bitcoin'],
        }),
      );
      const results = await backend.query({ '#t': ['nostr'] });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('e1');
    });

    it('queries multiple tag values (OR)', async () => {
      await backend.put(
        makeStored({
          event: { id: 'e1', tags: [['t', 'nostr']] },
          _tag_index: ['t:nostr'],
        }),
      );
      await backend.put(
        makeStored({
          event: { id: 'e2', tags: [['t', 'bitcoin']] },
          _tag_index: ['t:bitcoin'],
        }),
      );
      await backend.put(
        makeStored({
          event: { id: 'e3', tags: [['t', 'lightning']] },
          _tag_index: ['t:lightning'],
        }),
      );
      const results = await backend.query({ '#t': ['nostr', 'bitcoin'] });
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.id).sort()).toEqual(['e1', 'e2']);
    });
  });

  describe('Priority 3: authors + kinds compound', () => {
    it('queries by authors and kinds', async () => {
      const pk1 = 'a'.repeat(64);
      const pk2 = 'b'.repeat(64);
      await backend.put(makeStored({ event: { id: 'e1', pubkey: pk1, kind: 1 } }));
      await backend.put(makeStored({ event: { id: 'e2', pubkey: pk1, kind: 7 } }));
      await backend.put(makeStored({ event: { id: 'e3', pubkey: pk2, kind: 1 } }));
      const results = await backend.query({ authors: [pk1], kinds: [1] });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('e1');
    });
  });

  describe('Priority 4: authors only', () => {
    it('queries by authors', async () => {
      const pk1 = 'a'.repeat(64);
      const pk2 = 'b'.repeat(64);
      await backend.put(makeStored({ event: { id: 'e1', pubkey: pk1 } }));
      await backend.put(makeStored({ event: { id: 'e2', pubkey: pk2 } }));
      const results = await backend.query({ authors: [pk1] });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('e1');
    });

    it('author prefix search (shorter than 64 chars)', async () => {
      const pk1 = 'ab' + 'c'.repeat(62);
      const pk2 = 'cd' + 'e'.repeat(62);
      await backend.put(makeStored({ event: { id: 'e1', pubkey: pk1 } }));
      await backend.put(makeStored({ event: { id: 'e2', pubkey: pk2 } }));
      const results = await backend.query({ authors: ['ab'] });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('e1');
    });
  });

  describe('Priority 5: kinds only', () => {
    it('queries by single kind', async () => {
      await backend.put(makeStored({ event: { id: 'e1', kind: 1 } }));
      await backend.put(makeStored({ event: { id: 'e2', kind: 7 } }));
      const results = await backend.query({ kinds: [1] });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('e1');
    });

    it('queries by multiple kinds', async () => {
      await backend.put(makeStored({ event: { id: 'e1', kind: 1 } }));
      await backend.put(makeStored({ event: { id: 'e2', kind: 7 } }));
      await backend.put(makeStored({ event: { id: 'e3', kind: 0 } }));
      const results = await backend.query({ kinds: [1, 7] });
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.id).sort()).toEqual(['e1', 'e2']);
    });
  });

  describe('since/until filtering', () => {
    it('filters by since', async () => {
      await backend.put(makeStored({ event: { id: 'e1', created_at: 500 } }));
      await backend.put(makeStored({ event: { id: 'e2', created_at: 1500 } }));
      const results = await backend.query({ since: 1000 });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('e2');
    });

    it('filters by until', async () => {
      await backend.put(makeStored({ event: { id: 'e1', created_at: 500 } }));
      await backend.put(makeStored({ event: { id: 'e2', created_at: 1500 } }));
      const results = await backend.query({ until: 1000 });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('e1');
    });

    it('filters by since and until together', async () => {
      await backend.put(makeStored({ event: { id: 'e1', created_at: 500 } }));
      await backend.put(makeStored({ event: { id: 'e2', created_at: 1000 } }));
      await backend.put(makeStored({ event: { id: 'e3', created_at: 1500 } }));
      const results = await backend.query({ since: 600, until: 1200 });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('e2');
    });
  });

  describe('limit', () => {
    it('respects limit', async () => {
      for (let i = 0; i < 10; i++) {
        await backend.put(makeStored({ event: { id: `e${i}`, created_at: i * 100 } }));
      }
      const results = await backend.query({ limit: 3 });
      expect(results).toHaveLength(3);
    });

    it('returns in descending created_at order', async () => {
      await backend.put(makeStored({ event: { id: 'e1', created_at: 100 } }));
      await backend.put(makeStored({ event: { id: 'e2', created_at: 300 } }));
      await backend.put(makeStored({ event: { id: 'e3', created_at: 200 } }));
      const results = await backend.query({ limit: 3 });
      expect(results.map((r) => r.created_at)).toEqual([300, 200, 100]);
    });
  });

  describe('Priority 6: fallback (empty filter)', () => {
    it('returns all events with empty filter', async () => {
      await backend.put(makeStored({ event: { id: 'e1' } }));
      await backend.put(makeStored({ event: { id: 'e2' } }));
      await backend.put(makeStored({ event: { id: 'e3' } }));
      const results = await backend.query({});
      expect(results).toHaveLength(3);
    });

    it('returns in descending created_at order', async () => {
      await backend.put(makeStored({ event: { id: 'e1', created_at: 100 } }));
      await backend.put(makeStored({ event: { id: 'e2', created_at: 300 } }));
      await backend.put(makeStored({ event: { id: 'e3', created_at: 200 } }));
      const results = await backend.query({});
      expect(results.map((r) => r.created_at)).toEqual([300, 200, 100]);
    });
  });
});
