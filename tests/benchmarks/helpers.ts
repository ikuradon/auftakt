import 'fake-indexeddb/auto';
import { createEventStore, type EventStore } from '../../src/core/store.js';
import { memoryBackend, type MemoryBackend } from '../../src/backends/memory.js';
import type { NostrEvent } from '../../src/types.js';

const PUBKEYS = Array.from({ length: 100 }, (_, i) => i.toString(16).padStart(64, '0'));

const KINDS = [0, 1, 3, 5, 6, 7, 30023];

let counter = 0;

export function generateEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  const id = (counter++).toString(16).padStart(64, '0');
  const pubkey = PUBKEYS[counter % PUBKEYS.length];
  const kind = overrides.kind ?? KINDS[counter % KINDS.length];
  return {
    id,
    pubkey,
    kind,
    created_at: Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 86400 * 30),
    tags: kind === 1 ? [['p', PUBKEYS[(counter + 1) % PUBKEYS.length]]] : [],
    content: `content-${id.slice(0, 8)}`,
    sig: 'sig' + id.slice(0, 60),
    ...overrides,
  };
}

export function resetCounter(): void {
  counter = 0;
}

export interface SetupResult {
  store: EventStore;
  backend: MemoryBackend;
}

export async function setupStoreWithEvents(count: number): Promise<SetupResult> {
  resetCounter();
  const backend = memoryBackend({ maxEvents: count + 1000 });
  const store = createEventStore({ backend });
  for (let i = 0; i < count; i++) {
    await store.add(generateEvent());
  }
  return { store, backend };
}

export async function measureMs(fn: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}
