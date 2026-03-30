import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockPool } from '@ikuradon/tsunagiya';
import { createRxNostr, createRxOneshotReq } from 'rx-nostr';
import { firstValueFrom } from 'rxjs';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import type { NostrEvent } from '../../src/types.js';

const RELAY_URL = 'wss://relay.test';

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

/**
 * Helper: fetch a single event from relay using rx-nostr oneshot req.
 */
function createRelayFetcher(rxNostr: ReturnType<typeof createRxNostr>) {
  return async (eventId: string): Promise<{ event: NostrEvent; relay: string } | null> => {
    return new Promise((resolve) => {
      const req = createRxOneshotReq({ filters: { ids: [eventId] } });
      let found = false;

      const sub = rxNostr.use(req).subscribe({
        next: (packet) => {
          if (packet.event.id === eventId) {
            found = true;
            sub.unsubscribe();
            resolve({ event: packet.event as NostrEvent, relay: packet.from });
          }
        },
        complete: () => {
          if (!found) resolve(null);
        },
      });

      setTimeout(() => {
        if (!found) {
          sub.unsubscribe();
          resolve(null);
        }
      }, 3000);
    });
  };
}

describe('store.fetchById with relay fetch (tsunagiya)', () => {
  let pool: MockPool;

  beforeEach(() => {
    pool = new MockPool();
    pool.install();
  });

  afterEach(() => {
    pool.uninstall();
  });

  it('fetches from relay when not in local cache', async () => {
    const relay = pool.relay(RELAY_URL);
    const targetEvent = makeEvent({ id: 'remote1', kind: 1, pubkey: 'pk1', created_at: 2000 });
    relay.store(targetEvent);

    const rxNostr = createRxNostr({ verifier: async () => true });
    rxNostr.setDefaultRelays([RELAY_URL]);

    const store = createEventStore({ backend: memoryBackend() });
    const fetch = createRelayFetcher(rxNostr);

    const result = await store.fetchById('remote1', { fetch, timeout: 3000 });

    expect(result).not.toBeNull();
    expect(result!.event.id).toBe('remote1');

    rxNostr.dispose();
  });

  it('returns null and sets negative cache when relay has no event', async () => {
    pool.relay(RELAY_URL); // empty relay

    const rxNostr = createRxNostr({ verifier: async () => true });
    rxNostr.setDefaultRelays([RELAY_URL]);

    const store = createEventStore({ backend: memoryBackend() });
    const fetch = createRelayFetcher(rxNostr);

    const result = await store.fetchById('missing1', {
      fetch,
      timeout: 3000,
      negativeTTL: 30_000,
    });

    expect(result).toBeNull();

    // Second fetch hits negative cache
    const result2 = await store.fetchById('missing1', {
      fetch,
      negativeTTL: 30_000,
    });
    expect(result2).toBeNull();

    rxNostr.dispose();
  });

  it('prefers local cache over relay', async () => {
    const relay = pool.relay(RELAY_URL);
    relay.store(makeEvent({ id: 'cached1', content: 'from relay' }));

    const rxNostr = createRxNostr({ verifier: async () => true });
    rxNostr.setDefaultRelays([RELAY_URL]);

    const store = createEventStore({ backend: memoryBackend() });
    await store.add(makeEvent({ id: 'cached1', content: 'from cache' }));

    const fetch = createRelayFetcher(rxNostr);
    const result = await store.fetchById('cached1', { fetch });
    expect(result!.event.content).toBe('from cache');

    rxNostr.dispose();
  });
});
