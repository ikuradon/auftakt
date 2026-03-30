import { describe, it, expect } from 'vitest';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import { firstValueFrom, filter } from 'rxjs';
import type { NostrEvent, CachedEvent } from '../../src/types.js';

const wait = (ms = 50) => new Promise(r => setTimeout(r, ms));

const makeEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
  id: 'e1', kind: 1, pubkey: 'pk1', created_at: 1000,
  tags: [], content: '', sig: 'sig1',
  ...overrides,
});

describe('tag index configuration', () => {
  it('indexes all tags by default (NIP-01 compliant)', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add(makeEvent({
      id: 'a',
      tags: [['e', 'ref1'], ['p', 'pk2'], ['t', 'nostr'], ['x', 'custom']],
    }));
    await wait();

    // All tag queries should work
    for (const [tag, value] of [['e', 'ref1'], ['p', 'pk2'], ['t', 'nostr'], ['x', 'custom']]) {
      const events = await firstValueFrom(
        store.query({ [`#${tag}`]: [value] }).pipe(filter((e: CachedEvent[]) => e.length > 0))
      );
      expect(events).toHaveLength(1);
    }
  });

  it('restricts indexing to specified tags when indexedTags is set', async () => {
    const store = createEventStore({
      backend: memoryBackend(),
      indexedTags: ['e', 'p'],
    });
    await store.add(makeEvent({
      id: 'a',
      tags: [['e', 'ref1'], ['p', 'pk2'], ['t', 'nostr'], ['x', 'custom']],
    }));
    await wait();

    // Indexed tags should work
    const eResult = await firstValueFrom(
      store.query({ '#e': ['ref1'] }).pipe(filter((e: CachedEvent[]) => e.length > 0))
    );
    expect(eResult).toHaveLength(1);

    const pResult = await firstValueFrom(
      store.query({ '#p': ['pk2'] }).pipe(filter((e: CachedEvent[]) => e.length > 0))
    );
    expect(pResult).toHaveLength(1);

    // Non-indexed tags should NOT match
    // Wait for query to fully flush, then verify empty
    const tCollected: number[] = [];
    const sub = store.query({ '#t': ['nostr'] }).subscribe(e => tCollected.push(e.length));
    await wait(100);
    sub.unsubscribe();
    // All emissions should be 0 (never finds the event via #t since 't' is not indexed)
    expect(tCollected.every(n => n === 0)).toBe(true);
  });

  it('passes indexedTags through to backend via stored event', async () => {
    const store = createEventStore({
      backend: memoryBackend(),
      indexedTags: ['e'],
    });

    await store.add(makeEvent({
      id: 'a',
      tags: [['e', 'ref1'], ['p', 'pk2']],
    }));
    await wait();

    // #e works
    const eResult = await firstValueFrom(
      store.query({ '#e': ['ref1'] }).pipe(filter((e: CachedEvent[]) => e.length > 0))
    );
    expect(eResult).toHaveLength(1);

    // #p doesn't (not indexed)
    const pCollected: number[] = [];
    const sub = store.query({ '#p': ['pk2'] }).subscribe(e => pCollected.push(e.length));
    await wait(100);
    sub.unsubscribe();
    expect(pCollected.every(n => n === 0)).toBe(true);
  });
});
