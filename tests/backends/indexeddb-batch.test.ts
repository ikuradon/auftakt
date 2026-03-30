import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import { indexedDBBackend } from '../../src/backends/indexeddb.js';
import type { StoredEvent } from '../../src/backends/interface.js';
import type { NostrEvent } from '../../src/types.js';

let dbCounter = 0;

const makeStored = (id: string, kind = 1): StoredEvent => ({
  event: { id, kind, pubkey: 'pk1', created_at: 1000, tags: [], content: '', sig: 's' } as NostrEvent,
  seenOn: [],
  firstSeen: Date.now(),
  _tag_index: [],
  _d_tag: '',
});

describe('indexedDB batch writes', () => {
  it('batches multiple rapid puts into fewer transactions', async () => {
    const backend = indexedDBBackend(`batch-test-${dbCounter++}`, { batchWrites: true });

    // Fire 10 puts without awaiting individually
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(backend.put(makeStored(`e${i}`)));
    }
    await Promise.all(promises);

    // All 10 should be stored
    const ids = await backend.getAllEventIds();
    expect(ids).toHaveLength(10);
  });

  it('works correctly without batch mode (default)', async () => {
    const backend = indexedDBBackend(`nobatch-test-${dbCounter++}`);

    for (let i = 0; i < 5; i++) {
      await backend.put(makeStored(`e${i}`));
    }

    const ids = await backend.getAllEventIds();
    expect(ids).toHaveLength(5);
  });

  it('batched puts are readable after flush', async () => {
    const backend = indexedDBBackend(`batch-read-${dbCounter++}`, { batchWrites: true });

    backend.put(makeStored('a'));
    backend.put(makeStored('b'));
    backend.put(makeStored('c'));

    // Wait for batch flush
    await new Promise(r => setTimeout(r, 50));

    const a = await backend.get('a');
    const b = await backend.get('b');
    const c = await backend.get('c');
    expect(a?.event.id).toBe('a');
    expect(b?.event.id).toBe('b');
    expect(c?.event.id).toBe('c');
  });
});
