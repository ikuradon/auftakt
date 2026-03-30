import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StorageBackend } from '../../src/backends/interface.js';
import type { NostrEvent } from '../../src/types.js';

const baseEvent: NostrEvent = {
  id: 'e1', kind: 1, pubkey: 'pk1', created_at: 1000,
  tags: [], content: 'hello', sig: 'sig1',
};

describe('indexedDBBackend SSR fallback', () => {
  let originalIndexedDB: any;

  beforeEach(() => {
    originalIndexedDB = globalThis.indexedDB;
  });

  afterEach(() => {
    globalThis.indexedDB = originalIndexedDB;
  });

  it('falls back to memory backend when indexedDB is undefined', async () => {
    // Simulate SSR environment
    (globalThis as any).indexedDB = undefined;

    // Dynamic import to pick up the undefined indexedDB
    const { indexedDBBackend } = await import('../../src/backends/indexeddb.js');
    const backend = indexedDBBackend('ssr-test');

    // Should still work (memory fallback)
    await backend.put({
      event: baseEvent,
      seenOn: ['wss://r1'],
      firstSeen: Date.now(),
      _tag_index: [],
      _d_tag: '',
    });

    const result = await backend.get('e1');
    expect(result?.event.id).toBe('e1');
  });
});
