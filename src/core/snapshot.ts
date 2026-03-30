import type { NostrEvent, NostrFilter } from '../types.js';
import type { EventStore } from './store.js';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SnapshotOptions {
  key: string;
  storage?: StorageLike;
}

export interface SaveSnapshotOptions extends SnapshotOptions {
  filter: NostrFilter;
}

/**
 * Save a snapshot of store events to localStorage (synchronous storage).
 * Use to speed up initial paint on next page load.
 */
export async function saveSnapshot(
  store: EventStore,
  options: SaveSnapshotOptions,
): Promise<void> {
  const storage = options.storage ?? globalThis.localStorage;
  if (!storage) return;

  const events = await store.getSync(options.filter);
  const serialized = JSON.stringify(events.map(e => e.event));

  try {
    storage.setItem(options.key, serialized);
  } catch {
    // QuotaExceeded or other storage errors — silently ignore
  }
}

/**
 * Load a snapshot from localStorage into the store.
 * Returns the number of events loaded.
 */
export async function loadSnapshot(
  store: EventStore,
  options: SnapshotOptions,
): Promise<number> {
  const storage = options.storage ?? globalThis.localStorage;
  if (!storage) return 0;

  const raw = storage.getItem(options.key);
  if (!raw) return 0;

  let events: NostrEvent[];
  try {
    events = JSON.parse(raw);
    if (!Array.isArray(events)) return 0;
  } catch {
    return 0;
  }

  let count = 0;
  for (const event of events) {
    if (!event || !event.id || typeof event.kind !== 'number') continue;
    const result = await store.add(event);
    if (result === 'added' || result === 'replaced') count++;
  }

  return count;
}
