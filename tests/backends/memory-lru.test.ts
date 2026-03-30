import { describe, it, expect, beforeEach } from 'vitest';
import { memoryBackend } from '../../src/backends/memory.js';
import type { StorageBackend, StoredEvent } from '../../src/backends/interface.js';
import type { NostrEvent } from '../../src/types.js';

const makeStored = (id: string, kind = 1, overrides: Partial<StoredEvent> = {}): StoredEvent => ({
  event: { id, kind, pubkey: 'pk1', created_at: 1000, tags: [], content: '', sig: 's' } as NostrEvent,
  seenOn: [],
  firstSeen: Date.now(),
  _tag_index: [],
  _d_tag: '',
  ...overrides,
});

describe('memoryBackend LRU eviction', () => {
  it('does not evict when maxEvents is not set', async () => {
    const backend = memoryBackend();
    for (let i = 0; i < 100; i++) {
      await backend.put(makeStored(`e${i}`));
    }
    const ids = await backend.getAllEventIds();
    expect(ids).toHaveLength(100);
  });

  it('evicts LRU events when maxEvents is exceeded', async () => {
    const backend = memoryBackend({ maxEvents: 5 });
    for (let i = 0; i < 8; i++) {
      await backend.put(makeStored(`e${i}`));
    }
    const ids = await backend.getAllEventIds();
    expect(ids).toHaveLength(5);
    // Oldest (e0, e1, e2) should be evicted, newest (e3-e7) should remain
    expect(ids).not.toContain('e0');
    expect(ids).not.toContain('e1');
    expect(ids).not.toContain('e2');
    expect(ids).toContain('e7');
  });

  it('updates access time on get()', async () => {
    const backend = memoryBackend({ maxEvents: 3 });
    await backend.put(makeStored('e0'));
    await backend.put(makeStored('e1'));
    await backend.put(makeStored('e2'));

    // Access e0 to make it recently used
    await backend.get('e0');

    // Add one more — should evict e1 (oldest access), not e0
    await backend.put(makeStored('e3'));
    const ids = await backend.getAllEventIds();
    expect(ids).toHaveLength(3);
    expect(ids).toContain('e0'); // accessed recently
    expect(ids).not.toContain('e1'); // oldest access
  });

  it('updates access time on query() results', async () => {
    const backend = memoryBackend({ maxEvents: 3 });
    await backend.put(makeStored('e0', 1));
    await backend.put(makeStored('e1', 7));
    await backend.put(makeStored('e2', 1));

    // Query kind:1 — touches e0 and e2
    await backend.query({ kinds: [1] });

    // Add one more — should evict e1 (only untouched by query)
    await backend.put(makeStored('e3', 1));
    const ids = await backend.getAllEventIds();
    expect(ids).toHaveLength(3);
    expect(ids).toContain('e0');
    expect(ids).toContain('e2');
    expect(ids).not.toContain('e1');
  });

  describe('kind budgets', () => {
    it('evicts within kind when kind budget exceeded', async () => {
      const backend = memoryBackend({
        maxEvents: 100,
        eviction: {
          strategy: 'lru',
          budgets: { 7: { max: 2 }, default: { max: 100 } },
        },
      });

      await backend.put(makeStored('r0', 7));
      await backend.put(makeStored('r1', 7));
      await backend.put(makeStored('r2', 7)); // exceeds kind:7 budget of 2

      const ids = await backend.getAllEventIds();
      const kind7 = ids.filter(id => id.startsWith('r'));
      expect(kind7).toHaveLength(2);
      expect(ids).not.toContain('r0'); // oldest kind:7
    });

    it('uses default budget for unspecified kinds', async () => {
      const backend = memoryBackend({
        maxEvents: 100,
        eviction: {
          strategy: 'lru',
          budgets: { default: { max: 2 } },
        },
      });

      await backend.put(makeStored('e0', 42));
      await backend.put(makeStored('e1', 42));
      await backend.put(makeStored('e2', 42)); // exceeds default budget

      const ids = await backend.getAllEventIds();
      const kind42 = ids.filter(id => id.startsWith('e'));
      expect(kind42).toHaveLength(2);
    });

    it('merges user budgets with defaults', async () => {
      const backend = memoryBackend({
        maxEvents: 100,
        eviction: {
          strategy: 'lru',
          budgets: { 0: { max: 2 } }, // override kind:0 only
        },
      });

      // Add 3 kind:0 events
      await backend.put(makeStored('p0', 0));
      await backend.put(makeStored('p1', 0));
      await backend.put(makeStored('p2', 0)); // exceeds overridden budget of 2

      const ids = await backend.getAllEventIds();
      const kind0 = ids.filter(id => id.startsWith('p'));
      expect(kind0).toHaveLength(2);
    });
  });

  describe('pinned events', () => {
    it('does not evict pinned events', async () => {
      const backend = memoryBackend({ maxEvents: 3 });

      await backend.put(makeStored('e0'));
      await backend.put(makeStored('e1'));
      await backend.put(makeStored('e2'));

      // Pin e0
      backend.setPinnedIds(new Set(['e0']));

      // Add one more — should evict e1 (oldest non-pinned), not e0
      await backend.put(makeStored('e3'));
      const ids = await backend.getAllEventIds();
      expect(ids).toHaveLength(3);
      expect(ids).toContain('e0'); // pinned
      expect(ids).not.toContain('e1'); // evicted
    });

    it('skips all pinned and evicts next candidate', async () => {
      const backend = memoryBackend({ maxEvents: 3 });

      await backend.put(makeStored('e0'));
      await backend.put(makeStored('e1'));
      await backend.put(makeStored('e2'));

      // Pin e0 and e1
      backend.setPinnedIds(new Set(['e0', 'e1']));

      // Add one more — only e2 is evictable
      await backend.put(makeStored('e3'));
      const ids = await backend.getAllEventIds();
      expect(ids).toContain('e0');
      expect(ids).toContain('e1');
      expect(ids).not.toContain('e2');
      expect(ids).toContain('e3');
    });
  });
});
