# createEventStore

```typescript
import { createEventStore } from '@ikuradon/auftakt';
```

## `createEventStore(options)`

Creates a new event store instance.

### Options

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `backend` | `StorageBackend` | required | Storage backend (memory, indexeddb, cached) |
| `indexedTags` | `string[]` | `undefined` (all) | Tag names to index for `#<tag>` queries. Default: all tags (NIP-01 compliant) |

### Returns: `EventStore`

## `store.add(event, meta?)`

```typescript
const result = await store.add(event, { relay: 'wss://relay.example.com' });
// result: 'added' | 'replaced' | 'deleted' | 'duplicate' | 'expired' | 'ephemeral'
```

Adds an event following NIP semantics. See [Core Concepts](/guide/core-concepts) for the full add() flow.

## `store.query(filter)`

```typescript
const events$ = store.query({ kinds: [1], authors: [pubkey], limit: 50 });
```

Returns `Observable<CachedEvent[]>` — reactive, re-emits on store changes.

## `store.getSync(filter)`

```typescript
const events = await store.getSync({ kinds: [0], authors: [pubkey] });
```

Returns `Promise<CachedEvent[]>` — non-reactive snapshot.

## `store.fetchById(eventId, options?)`

```typescript
const event = await store.fetchById('abc123', {
  fetch: async (id) => fetchFromRelay(id),
  negativeTTL: 30_000,
});
```

| Option | Type | Description |
|--------|------|-------------|
| `fetch` | `(id: string) => Promise<{event, relay} \| null>` | Relay fetch function |
| `negativeTTL` | `number` | Remember "not found" for this many ms |
| `timeout` | `number` | Fetch timeout (default: 5000) |

## `store.changes$`

```typescript
store.changes$.subscribe(({ event, type, relay }) => {
  // type: 'added' | 'replaced' | 'deleted'
});
```

# connectStore

```typescript
import { connectStore } from '@ikuradon/auftakt/sync';
```

## `connectStore(rxNostr, store, options?)`

Feeds all events from rx-nostr into the store.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `rxNostr` | `{ createAllEventObservable(), use?() }` | rx-nostr instance |
| `store` | `EventStore` | Store to feed events into |
| `options` | `ConnectStoreOptions` | Optional configuration |

### Options

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `filter` | `(event, meta: {relay}) => boolean` | `undefined` | Filter events before storing. Ephemeral (20000-29999) are always excluded by the store. |
| `reconcileDeletions` | `boolean` | `false` | On startup, fetch kind:5 events for cached event IDs to verify deletion integrity |

### Returns

`() => void` — disconnect function. Call to stop feeding events.

### Example

```typescript
const disconnect = connectStore(rxNostr, store, {
  filter: (event, { relay }) => {
    if (event.kind === 4) return false; // exclude DMs
    return true;
  },
  reconcileDeletions: true,
});

// Later
disconnect();
```

### Gotcha: Filter Mismatch

If `connectStore` excludes a kind via filter, `createSyncedQuery` requesting that kind will always return empty results. The library warns about this in the console.

# createSyncedQuery

```typescript
import { createSyncedQuery } from '@ikuradon/auftakt/sync';
```

## `createSyncedQuery(rxNostr, store, options)`

Manages REQ lifecycle + reactive store query.

### Options

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `filter` | `NostrFilter` | required | Nostr filter |
| `strategy` | `'backward' \| 'forward' \| 'dual'` | required | REQ strategy |
| `on` | `{ relays?: string[] }` | `undefined` | Relay targeting (passed to rx-nostr) |
| `staleTime` | `number` | `undefined` | Skip REQ if last fetch was within this ms |

### Returns

| Property | Type | Description |
|----------|------|-------------|
| `events$` | `Observable<CachedEvent[]>` | Reactive query results from store |
| `status$` | `Observable<SyncStatus>` | `'cached' \| 'fetching' \| 'live' \| 'complete'` |
| `emit` | `(filter: NostrFilter) => void` | Change filter (cancels in-flight backward) |
| `dispose` | `() => void` | Cleanup all subscriptions |

### Strategies

**backward:** `cached → fetching → complete`
```typescript
const { events$, status$ } = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [0], authors: [pubkey] },
  strategy: 'backward',
});
```

**forward:** `cached → live`
```typescript
const { events$ } = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [1], authors: followList },
  strategy: 'forward',
});
```

**dual:** `cached → fetching → live` (backward then forward)
```typescript
const { events$, status$ } = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [1], authors: followList },
  strategy: 'dual',
});
```

### Cache-Aware Since

Backward REQs automatically use the latest `created_at` from cached events as the `since` parameter, fetching only the delta.

### REQ Deduplication

Multiple SyncedQueries with identical filters share a single backward REQ (ref-counted). Disposed when all consumers unsubscribe.

### staleTime

```typescript
const { events$ } = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [0], authors: [pubkey] },
  strategy: 'backward',
  staleTime: 5 * 60_000, // 5 minutes
});
```

Based on last backward REQ completion time (memory-only, resets on page reload).

### dispose()

1. Unsubscribes backward/forward subscriptions
2. Unregisters store query (stops reactive updates)
3. Completes `events$` and `status$`
4. `emit()` after dispose is no-op

# publishEvent

```typescript
import { publishEvent } from '@ikuradon/auftakt/sync';
```

## `publishEvent(rxNostr, store, eventParams, options?)`

Publishes an event via rx-nostr with optional optimistic store update.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `rxNostr` | `{ send() }` | rx-nostr instance |
| `store` | `EventStore` | Event store |
| `eventParams` | `EventParameters \| NostrEvent` | Event to publish. If signed (has `id` + `sig`), signer is optional. |
| `options` | `PublishOptions` | Optional configuration |

### Options

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `signer` | `EventSigner` | `undefined` | Signer for unsigned events. Optional if event is pre-signed. |
| `optimistic` | `boolean` | `false` | Add to store immediately before relay confirmation |
| `on` | `{ relays?: string[] }` | `undefined` | Relay targeting |

### Returns

`Observable<OkPacketAgainstEvent>` — rx-nostr's send() result.

### Example

```typescript
// Unsigned event
const ok$ = publishEvent(rxNostr, store, eventParams, {
  signer: nip07Signer(),
  optimistic: true,
});

// Pre-signed event
const ok$ = publishEvent(rxNostr, store, signedEvent, {
  optimistic: true,
});
```

### Optimistic Update

When `optimistic: true` and the event has `id` + `sig`, it's added to the store immediately. Reactive queries reflect it before relay confirmation.

No automatic rollback in current version. Relay rejection results are available via the returned `ok$` Observable.

# Backends API

## StorageBackend Interface

All backends implement:

```typescript
interface StorageBackend {
  put(stored: StoredEvent): Promise<void>;
  get(eventId: string): Promise<StoredEvent | null>;
  getByReplaceableKey(kind: number, pubkey: string): Promise<StoredEvent | null>;
  getByAddressableKey(kind: number, pubkey: string, dTag: string): Promise<StoredEvent | null>;
  query(filter: NostrFilter): Promise<StoredEvent[]>;
  delete(eventId: string): Promise<void>;
  getAllEventIds(): Promise<string[]>;
  clear(): Promise<void>;
}
```

## memoryBackend

```typescript
import { memoryBackend } from '@ikuradon/auftakt/backends/memory';
```

See [Backends Guide](/guide/backends) for options.

## indexedDBBackend

```typescript
import { indexedDBBackend } from '@ikuradon/auftakt/backends/indexeddb';
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `batchWrites` | `boolean` | `false` | Buffer writes and flush via `queueMicrotask()` |

### Additional Methods (IndexedDB only)

```typescript
await backend.markDeleted(eventId, deletionEventId);
const isDeleted = await backend.isDeleted(eventId);
await backend.setNegative(eventId, expiresAt);
const isNeg = await backend.isNegative(eventId);
```

## cachedBackend

```typescript
import { cachedBackend } from '@ikuradon/auftakt/backends/cached';
```

| Option | Type | Description |
|--------|------|-------------|
| `maxCached` | `number` | Maximum events in memory cache (LRU) |

# Types

## CachedEvent

```typescript
interface CachedEvent {
  event: NostrEvent;   // The raw Nostr event
  seenOn: string[];    // Relay URLs where this event was observed
  firstSeen: number;   // Timestamp when first received
}
```

## AddResult

```typescript
type AddResult =
  | 'added'      // New event stored
  | 'replaced'   // Replaceable/Addressable event updated
  | 'deleted'    // Event was in deletedIds (step 1.5) or pendingDeletions (step 8)
  | 'duplicate'  // Same event.id already exists
  | 'expired'    // NIP-40 expiration tag in the past
  | 'ephemeral'; // Kind 20000-29999, not stored
```

## StoreChange

```typescript
interface StoreChange {
  event: NostrEvent;
  type: 'added' | 'replaced' | 'deleted';
  relay?: string;
}
```

## NostrFilter

```typescript
interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [key: `#${string}`]: string[] | undefined; // tag filters
}
```

## SyncStatus

```typescript
type SyncStatus = 'cached' | 'fetching' | 'live' | 'complete';
```

## EventMeta

```typescript
interface EventMeta {
  relay?: string;
}
```

## EventStoreOptions

```typescript
interface EventStoreOptions {
  backend: StorageBackend;
  indexedTags?: string[]; // default: all tags (NIP-01 compliant)
}
```
