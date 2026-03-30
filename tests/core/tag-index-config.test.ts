import { describe, it, expect } from 'vitest';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import { firstValueFrom, filter } from 'rxjs';
import type { NostrEvent, CachedEvent } from '../../src/types.js';

const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));

const makeEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
  id: 'e1',
  kind: 1,
  pubkey: 'pk1',
  created_at: 1000,
  tags: [],
  content: '',
  sig: 'sig1',
  ...overrides,
});

describe('tag index configuration', () => {
  it('indexes all tags by default (NIP-01 compliant)', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add(
      makeEvent({
        id: 'a',
        tags: [
          ['e', 'ref1'],
          ['p', 'pk2'],
          ['t', 'nostr'],
          ['x', 'custom'],
        ],
      }),
    );
    await wait();

    for (const [tag, value] of [
      ['e', 'ref1'],
      ['p', 'pk2'],
      ['t', 'nostr'],
      ['x', 'custom'],
    ]) {
      const events = await firstValueFrom(
        store.query({ [`#${tag}`]: [value] }).pipe(filter((e: CachedEvent[]) => e.length > 0)),
      );
      expect(events).toHaveLength(1);
    }
  });

  it('indexedTags restricts IDB index entries but memory queries still work via matchesFilter', async () => {
    // indexedTags only affects _tag_index (IDB optimization).
    // Memory backend queries via matchesFilter() which checks event.tags directly.
    // So all tag queries still work regardless of indexedTags setting.
    const store = createEventStore({
      backend: memoryBackend(),
      indexedTags: ['e', 'p'],
    });
    await store.add(
      makeEvent({
        id: 'a',
        tags: [
          ['e', 'ref1'],
          ['p', 'pk2'],
          ['t', 'nostr'],
        ],
      }),
    );
    await wait();

    // All tags queryable via matchesFilter
    for (const [tag, value] of [
      ['e', 'ref1'],
      ['p', 'pk2'],
      ['t', 'nostr'],
    ]) {
      const events = await firstValueFrom(
        store.query({ [`#${tag}`]: [value] }).pipe(filter((e: CachedEvent[]) => e.length > 0)),
      );
      expect(events).toHaveLength(1);
    }
  });

  it('indexedTags restricts _tag_index content in stored events', async () => {
    // Verify that the stored event's _tag_index only contains indexed tags
    const backend = memoryBackend();
    const store = createEventStore({ backend, indexedTags: ['e'] });
    await store.add(
      makeEvent({
        id: 'a',
        tags: [
          ['e', 'ref1'],
          ['p', 'pk2'],
        ],
      }),
    );

    const stored = await backend.get('a');
    // Only 'e' tag should be in _tag_index
    expect(stored?._tag_index).toEqual(['e:ref1']);
    // 'p' tag should NOT be in _tag_index (not indexed)
    expect(stored?._tag_index).not.toContain('p:pk2');
  });
});
