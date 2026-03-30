# @ikuradon/auftakt

> Reactive event store for [rx-nostr](https://github.com/penpenpng/rx-nostr) with NIP semantics.

**Auftakt** (アウフタクト) — a musical term for the upbeat note before the downbeat. Cache serves data before the relay responds.

## Features

- **NIP-compliant event store** — Replaceable, Addressable, Ephemeral, Kind 5 deletion, NIP-40 expiration
- **Reactive queries** — `Observable<CachedEvent[]>` that re-emit on store changes
- **Pluggable backends** — Memory (default) or IndexedDB for persistence
- **rx-nostr integration** — `connectStore()` for global feed, `createSyncedQuery()` for REQ lifecycle
- **Cache-aware fetch** — Backward REQs use `since` from cached data to minimize bandwidth

## Install

```bash
pnpm add @ikuradon/auftakt
# peer dependencies
pnpm add rx-nostr rxjs
```

## Quick Start

```typescript
import { createEventStore } from '@ikuradon/auftakt';
import { indexedDBBackend } from '@ikuradon/auftakt/backends/indexeddb';
import { connectStore, createSyncedQuery } from '@ikuradon/auftakt/sync';
import { createRxNostr } from 'rx-nostr';
import { verifier } from '@rx-nostr/crypto';

// 1. Create store
const store = createEventStore({
  backend: indexedDBBackend('my-app'),
});

// 2. Connect rx-nostr (feeds all events into store)
const rxNostr = createRxNostr({ verifier });
rxNostr.setDefaultRelays(['wss://relay.damus.io']);
const disconnect = connectStore(rxNostr, store, {
  filter: (event, { relay }) => event.kind !== 4, // exclude DMs
  reconcileDeletions: true,
});

// 3. Query with reactive updates
const { events$, status$, dispose } = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [1], authors: ['pubkey1'] },
  strategy: 'dual', // backward fetch + forward subscription
});

events$.subscribe(events => {
  console.log(`${events.length} events`);
});

status$.subscribe(status => {
  // 'cached' → 'fetching' → 'live'
  console.log(status);
});
```

## API

### `createEventStore(options)`

```typescript
import { createEventStore } from '@ikuradon/auftakt';
import { memoryBackend } from '@ikuradon/auftakt/backends/memory';
import { indexedDBBackend } from '@ikuradon/auftakt/backends/indexeddb';

const store = createEventStore({
  backend: memoryBackend(),
  // or: indexedDBBackend('db-name')
});
```

### `store.add(event, meta?): Promise<AddResult>`

Adds an event following NIP semantics:

- **Ephemeral** (kind 20000-29999): rejected
- **Replaceable** (kind 0, 3, 10000-19999): replaces older by `(pubkey, kind)`
- **Addressable** (kind 30000-39999): replaces older by `(kind, pubkey, d-tag)`
- **Kind 5**: marks referenced events as deleted (pubkey verification)
- **NIP-40**: rejects expired events

Returns: `'added' | 'replaced' | 'deleted' | 'duplicate' | 'expired' | 'ephemeral'`

### `store.query(filter): Observable<CachedEvent[]>`

Reactive query using standard Nostr filter format (`ids`, `kinds`, `authors`, `since`, `until`, `limit`, `#e`, `#p`, `#t`, etc.).

```typescript
// Reactive — re-emits when store changes
store.query({ kinds: [0], authors: [pubkey] }).subscribe(profiles => { ... });

// Pagination
store.query({ kinds: [1], until: oldestTimestamp, limit: 25 }).subscribe(page => { ... });

// Tag queries
store.query({ kinds: [7], '#e': [eventId] }).subscribe(reactions => { ... });
```

### `store.fetchById(eventId, options?): Promise<CachedEvent | null>`

Fetch a single event. Checks local cache first, then optionally fetches from relay.

```typescript
const event = await store.fetchById('abc123', {
  fetch: async (id) => { /* relay fetch logic */ },
  negativeTTL: 30_000, // remember "not found" for 30s
});
```

### `store.changes$: Observable<StoreChange>`

Stream of all store mutations. Useful for bridging with external caches (TanStack Query, etc.).

```typescript
store.changes$.subscribe(({ event, type, relay }) => {
  // type: 'added' | 'replaced' | 'deleted'
});
```

### `connectStore(rxNostr, store, options?)`

Feeds all events from rx-nostr into the store.

```typescript
import { connectStore } from '@ikuradon/auftakt/sync';

const disconnect = connectStore(rxNostr, store, {
  filter: (event, { relay }) => event.kind !== 4,
  reconcileDeletions: true, // startup kind:5 integrity check
});
```

### `createSyncedQuery(rxNostr, store, options)`

Manages REQ lifecycle + reactive store query.

```typescript
import { createSyncedQuery } from '@ikuradon/auftakt/sync';

const { events$, status$, emit, dispose } = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [1], authors: followList },
  strategy: 'dual',   // 'backward' | 'forward' | 'dual'
  on: { relays: ['wss://specific.relay'] },
  staleTime: 5 * 60_000,
});

// Change filter (cancels in-flight backward REQ)
emit({ kinds: [1], authors: newFollowList });

// Cleanup
dispose();
```

**Strategies:**
- `'backward'`: `cached → fetching → complete`
- `'forward'`: `cached → live`
- `'dual'`: `cached → fetching → live` (backward then forward)

### `publishEvent(rxNostr, store, eventParams, options?)`

```typescript
import { publishEvent } from '@ikuradon/auftakt/sync';

const ok$ = publishEvent(rxNostr, store, signedEvent, {
  optimistic: true, // add to store before relay confirmation
});
```

## Backends

### Memory (default)

```typescript
import { memoryBackend } from '@ikuradon/auftakt/backends/memory';
const backend = memoryBackend();
```

### IndexedDB (persistent)

```typescript
import { indexedDBBackend } from '@ikuradon/auftakt/backends/indexeddb';
const backend = indexedDBBackend('my-app');
```

- Auto-falls back to memory in SSR environments
- Write failures are logged but don't throw

## Svelte Integration

```typescript
import { createSvelteQuery } from '@ikuradon/auftakt/adapters/svelte';

// Returns Svelte 5 reactive state
const { events, status } = createSvelteQuery(rxNostr, store, {
  filter: { kinds: [1] },
  strategy: 'dual',
});
```

## Patterns

### Mute filtering

```typescript
// RxJS
combineLatest([events$, muteList$]).pipe(
  map(([events, muted]) => events.filter(e => !muted.has(e.event.pubkey)))
);

// Svelte
const filtered = $derived(events.filter(e => !isMuted(e.event.pubkey)));
```

### Multiple filter merge (addFilter alternative)

```typescript
const q1 = createSyncedQuery(rxNostr, store, { filter: filterA, strategy: 'dual' });
const q2 = createSyncedQuery(rxNostr, store, { filter: filterB, strategy: 'dual' });

const merged$ = combineLatest([
  q1.events$,
  q2.events$.pipe(startWith([])),
]).pipe(
  map(([a, b]) => {
    const seen = new Set<string>();
    return [...a, ...b].filter(e => {
      if (seen.has(e.event.id)) return false;
      seen.add(e.event.id);
      return true;
    });
  }),
);
```

## License

MIT
