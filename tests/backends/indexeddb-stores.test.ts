import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { indexedDBBackend } from '../../src/backends/indexeddb.js';
import type { StoredEvent } from '../../src/backends/interface.js';
import type { NostrEvent } from '../../src/types.js';

let dbCounter = 100;

const makeStored = (id: string, kind = 1): StoredEvent => ({
  event: { id, kind, pubkey: 'pk1', created_at: 1000, tags: [], content: '', sig: 's' } as NostrEvent,
  seenOn: ['wss://r1'],
  firstSeen: 1000,
  _tag_index: [],
  _d_tag: '',
});

describe('IDB deleted events persistence', () => {
  it('persists deleted event IDs', async () => {
    const backend = indexedDBBackend(`stores-test-${dbCounter++}`);
    await backend.put(makeStored('target'));

    await backend.markDeleted('target', 'del1');

    const isDeleted = await backend.isDeleted('target');
    expect(isDeleted).toBe(true);
  });

  it('returns false for non-deleted events', async () => {
    const backend = indexedDBBackend(`stores-test-${dbCounter++}`);
    const isDeleted = await backend.isDeleted('nonexistent');
    expect(isDeleted).toBe(false);
  });

  it('loads deleted IDs on init', async () => {
    const dbName = `stores-test-${dbCounter++}`;
    const backend1 = indexedDBBackend(dbName);
    await backend1.put(makeStored('target'));
    await backend1.markDeleted('target', 'del1');

    // Simulate new session — same DB name
    const backend2 = indexedDBBackend(dbName);
    const isDeleted = await backend2.isDeleted('target');
    expect(isDeleted).toBe(true);
  });
});

describe('IDB negative cache persistence', () => {
  it('persists negative cache entries', async () => {
    const backend = indexedDBBackend(`stores-test-${dbCounter++}`);

    await backend.setNegative('missing1', Date.now() + 60_000);

    const isNeg = await backend.isNegative('missing1');
    expect(isNeg).toBe(true);
  });

  it('returns false for expired negative entries', async () => {
    const backend = indexedDBBackend(`stores-test-${dbCounter++}`);

    await backend.setNegative('missing1', Date.now() - 1000); // already expired

    const isNeg = await backend.isNegative('missing1');
    expect(isNeg).toBe(false);
  });
});
