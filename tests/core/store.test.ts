import { describe, it, expect, beforeEach } from 'vitest';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import { firstValueFrom, skip } from 'rxjs';
import type { NostrEvent } from '../../src/types.js';

const makeEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
  id: 'e1',
  kind: 1,
  pubkey: 'pk1',
  created_at: 1000,
  tags: [],
  content: 'hello',
  sig: 'sig1',
  ...overrides,
});

/** Wait for reactive query to flush (microtask + async backend query) */
const flush = () => new Promise(r => setTimeout(r, 20));

describe('NostrEventStore', () => {
  let store: ReturnType<typeof createEventStore>;

  beforeEach(() => {
    store = createEventStore({ backend: memoryBackend() });
  });

  describe('add()', () => {
    it('adds a regular event', async () => {
      const result = await store.add(makeEvent());
      expect(result).toBe('added');
    });

    it('rejects ephemeral events', async () => {
      const result = await store.add(makeEvent({ kind: 20001 }));
      expect(result).toBe('ephemeral');
    });

    it('returns duplicate for same event id', async () => {
      await store.add(makeEvent());
      const result = await store.add(makeEvent());
      expect(result).toBe('duplicate');
    });

    it('updates seenOn on duplicate without duplicating entries', async () => {
      await store.add(makeEvent(), { relay: 'wss://relay1' });
      await store.add(makeEvent(), { relay: 'wss://relay2' });
      await store.add(makeEvent(), { relay: 'wss://relay1' });
      await flush();
      const events = await firstValueFrom(store.query({ ids: ['e1'] }).pipe(skip(1)));
      expect(events[0].seenOn).toEqual(['wss://relay1', 'wss://relay2']);
    });

    it('rejects expired events (NIP-40)', async () => {
      const result = await store.add(makeEvent({ tags: [['expiration', '1']] }));
      expect(result).toBe('expired');
    });

    it('replaces older replaceable event', async () => {
      await store.add(makeEvent({ id: 'old', kind: 0, pubkey: 'pk1', created_at: 1000 }));
      const result = await store.add(makeEvent({ id: 'new', kind: 0, pubkey: 'pk1', created_at: 2000 }));
      expect(result).toBe('replaced');
      await flush();
      const events = await firstValueFrom(store.query({ kinds: [0], authors: ['pk1'] }).pipe(skip(1)));
      expect(events).toHaveLength(1);
      expect(events[0].event.id).toBe('new');
    });

    it('discards older incoming replaceable event', async () => {
      await store.add(makeEvent({ id: 'new', kind: 0, pubkey: 'pk1', created_at: 2000 }));
      const result = await store.add(makeEvent({ id: 'old', kind: 0, pubkey: 'pk1', created_at: 1000 }));
      expect(result).toBe('duplicate');
    });

    it('handles addressable events with d-tag', async () => {
      await store.add(makeEvent({
        id: 'old', kind: 30023, pubkey: 'pk1', created_at: 1000,
        tags: [['d', 'hello']],
      }));
      const result = await store.add(makeEvent({
        id: 'new', kind: 30023, pubkey: 'pk1', created_at: 2000,
        tags: [['d', 'hello']],
      }));
      expect(result).toBe('replaced');
    });

    it('handles addressable events with empty d-tag fallback', async () => {
      await store.add(makeEvent({ id: 'a', kind: 30023, pubkey: 'pk1', created_at: 1000, tags: [] }));
      const result = await store.add(makeEvent({ id: 'b', kind: 30023, pubkey: 'pk1', created_at: 2000, tags: [] }));
      expect(result).toBe('replaced');
    });

    it('rejects already-deleted event via step 1.5 deletedIds check', async () => {
      await store.add(makeEvent({ id: 'target', kind: 1, pubkey: 'pk1' }));
      await store.add(makeEvent({
        id: 'del1', kind: 5, pubkey: 'pk1',
        tags: [['e', 'target']],
      }));
      const result = await store.add(makeEvent({ id: 'target', kind: 1, pubkey: 'pk1' }));
      expect(result).toBe('deleted');
    });
  });

  describe('kind:5 deletion', () => {
    it('marks referenced event as deleted', async () => {
      await store.add(makeEvent({ id: 'target', kind: 1, pubkey: 'pk1' }));
      await store.add(makeEvent({
        id: 'del1', kind: 5, pubkey: 'pk1',
        tags: [['e', 'target']],
      }));
      await flush();
      const events = await firstValueFrom(store.query({ ids: ['target'] }).pipe(skip(1)));
      expect(events).toHaveLength(0);
    });

    it('rejects deletion from different pubkey', async () => {
      await store.add(makeEvent({ id: 'target', kind: 1, pubkey: 'pk1' }));
      await store.add(makeEvent({
        id: 'del1', kind: 5, pubkey: 'pk2',
        tags: [['e', 'target']],
      }));
      await flush();
      const events = await firstValueFrom(store.query({ ids: ['target'] }).pipe(skip(1)));
      expect(events).toHaveLength(1);
    });

    it('handles pendingDeletions when target arrives later', async () => {
      await store.add(makeEvent({
        id: 'del1', kind: 5, pubkey: 'pk1', created_at: 2000,
        tags: [['e', 'target']],
      }));
      await store.add(makeEvent({ id: 'target', kind: 1, pubkey: 'pk1', created_at: 1000 }));
      await flush();
      const events = await firstValueFrom(store.query({ ids: ['target'] }).pipe(skip(1)));
      expect(events).toHaveLength(0);
    });

    it('handles a-tag deletion for addressable events', async () => {
      await store.add(makeEvent({
        id: 'addr1', kind: 30023, pubkey: 'pk1', created_at: 1000,
        tags: [['d', 'mypost']],
      }));
      await store.add(makeEvent({
        id: 'del1', kind: 5, pubkey: 'pk1', created_at: 2000,
        tags: [['a', '30023:pk1:mypost']],
      }));
      await flush();
      const events = await firstValueFrom(store.query({ kinds: [30023] }).pipe(skip(1)));
      expect(events).toHaveLength(0);
    });
  });

  describe('query()', () => {
    it('returns reactive Observable that updates on add', async () => {
      const collected: number[] = [];
      const sub = store.query({ kinds: [1] }).subscribe(events => {
        collected.push(events.length);
      });

      await flush();
      await store.add(makeEvent({ id: 'a' }));
      await flush();

      expect(collected).toContain(0);
      expect(collected).toContain(1);
      sub.unsubscribe();
    });

    it('excludes deleted events', async () => {
      await store.add(makeEvent({ id: 'a', kind: 1, pubkey: 'pk1' }));
      await store.add(makeEvent({ id: 'b', kind: 1, pubkey: 'pk1' }));
      await store.add(makeEvent({
        id: 'del', kind: 5, pubkey: 'pk1',
        tags: [['e', 'a']],
      }));
      await flush();
      const events = await firstValueFrom(store.query({ kinds: [1] }).pipe(skip(1)));
      expect(events).toHaveLength(1);
      expect(events[0].event.id).toBe('b');
    });

    it('supports since/until/limit', async () => {
      await store.add(makeEvent({ id: 'a', created_at: 100 }));
      await store.add(makeEvent({ id: 'b', created_at: 200 }));
      await store.add(makeEvent({ id: 'c', created_at: 300 }));
      await flush();
      const events = await firstValueFrom(store.query({ since: 150, until: 250, limit: 10 }).pipe(skip(1)));
      expect(events).toHaveLength(1);
      expect(events[0].event.id).toBe('b');
    });
  });

  describe('changes$', () => {
    it('emits on add', async () => {
      const changes: string[] = [];
      store.changes$.subscribe(c => changes.push(c.type));
      await store.add(makeEvent());
      expect(changes).toContain('added');
    });

    it('emits replaced on replaceable update', async () => {
      const changes: string[] = [];
      store.changes$.subscribe(c => changes.push(c.type));
      await store.add(makeEvent({ id: 'old', kind: 0, created_at: 1000 }));
      await store.add(makeEvent({ id: 'new', kind: 0, created_at: 2000 }));
      expect(changes).toContain('replaced');
    });

    it('emits deleted on kind:5', async () => {
      const changes: string[] = [];
      store.changes$.subscribe(c => changes.push(c.type));
      await store.add(makeEvent({ id: 'target', kind: 1, pubkey: 'pk1' }));
      await store.add(makeEvent({
        id: 'del1', kind: 5, pubkey: 'pk1',
        tags: [['e', 'target']],
      }));
      expect(changes).toContain('deleted');
    });
  });

  describe('fetchById()', () => {
    it('returns cached event if in store', async () => {
      await store.add(makeEvent({ id: 'cached1' }));
      const result = await store.fetchById('cached1');
      expect(result?.event.id).toBe('cached1');
    });

    it('returns null if not in store', async () => {
      const result = await store.fetchById('missing');
      expect(result).toBeNull();
    });

    it('deduplicates in-flight fetches for same id', async () => {
      const p1 = store.fetchById('missing');
      const p2 = store.fetchById('missing');
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBeNull();
      expect(r2).toBeNull();
    });

    it('uses negative cache to skip repeated fetches', async () => {
      await store.fetchById('missing', { negativeTTL: 60_000 });
      const result = await store.fetchById('missing', { negativeTTL: 60_000 });
      expect(result).toBeNull();
    });
  });
});
