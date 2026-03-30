import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import { saveSnapshot, loadSnapshot } from '../../src/core/snapshot.js';
import type { NostrEvent } from '../../src/types.js';

const wait = (ms = 50) => new Promise(r => setTimeout(r, ms));

const makeEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
  id: 'e1', kind: 1, pubkey: 'pk1', created_at: 1000,
  tags: [], content: '', sig: 'sig1',
  ...overrides,
});

// Mock localStorage
const storage = new Map<string, string>();
const mockLocalStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
};

describe('snapshot', () => {
  beforeEach(() => {
    storage.clear();
  });

  it('saveSnapshot serializes store events to localStorage', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add(makeEvent({ id: 'a', kind: 0, pubkey: 'pk1', created_at: 100 }));
    await store.add(makeEvent({ id: 'b', kind: 1, pubkey: 'pk1', created_at: 200 }));
    await wait();

    await saveSnapshot(store, {
      key: 'auftakt-snapshot',
      filter: { kinds: [0] }, // only profiles
      storage: mockLocalStorage as any,
    });

    const raw = storage.get('auftakt-snapshot');
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('a');
  });

  it('loadSnapshot hydrates store from localStorage', async () => {
    // Simulate saved snapshot
    const events = [makeEvent({ id: 'cached1', kind: 0, created_at: 100 })];
    storage.set('auftakt-snapshot', JSON.stringify(events));

    const store = createEventStore({ backend: memoryBackend() });

    const count = await loadSnapshot(store, {
      key: 'auftakt-snapshot',
      storage: mockLocalStorage as any,
    });

    expect(count).toBe(1);

    const result = await store.fetchById('cached1');
    expect(result?.event.id).toBe('cached1');
  });

  it('loadSnapshot returns 0 when no snapshot exists', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const count = await loadSnapshot(store, {
      key: 'auftakt-snapshot',
      storage: mockLocalStorage as any,
    });
    expect(count).toBe(0);
  });

  it('loadSnapshot handles corrupted data gracefully', async () => {
    storage.set('auftakt-snapshot', 'not-json');
    const store = createEventStore({ backend: memoryBackend() });
    const count = await loadSnapshot(store, {
      key: 'auftakt-snapshot',
      storage: mockLocalStorage as any,
    });
    expect(count).toBe(0);
  });
});
