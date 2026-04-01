# createEventStore

```typescript
import { createEventStore } from '@ikuradon/auftakt';
```

## `createEventStore(options)`

Creates a new event store instance.

### Options

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `backend` | `StorageBackend` | required | Storage backend (memory, dexie, cached) |
| `indexedTags` | `string[]` | `undefined` (all) | Tag names to index for `#<tag>` queries. Default: all tags (NIP-01 compliant) |
| `maxEventSize` | `number` | `undefined` | Maximum event size in characters (`JSON.stringify(event).length`). `undefined` = unlimited |

### Returns: `EventStore`

## `store.add(event, meta?)`

```typescript
const result = await store.add(event, { relay: 'wss://relay.example.com' });
// result: 'added' | 'replaced' | 'deleted' | 'duplicate' | 'expired' | 'ephemeral' | 'rejected'
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

## `store.getAllEventIds()`

```typescript
const ids = await store.getAllEventIds();
```

Returns `Promise<string[]>` — all event IDs in the backend. Used internally by `reconcileDeletions`.

## `store.dispose()`

```typescript
store.dispose();
```

Completes `changes$`, completes all reactive query subscribers, and clears in-flight requests.

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

# sendEvent

```typescript
import { sendEvent } from '@ikuradon/auftakt/sync';
```

## `sendEvent(rxNostr, store, eventParams, options?)`

Sign (if needed) and send an event via rx-nostr. Returns an Observable of relay OK responses.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `rxNostr` | `RxNostrSendLike` | rx-nostr instance (needs `send()`) |
| `store` | `EventStore` | Event store |
| `eventParams` | `EventParams` | Signed `NostrEvent` or unsigned `UnsignedEventParams` |
| `options` | `SendOptions` | Optional configuration |

### Options

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `signer` | `EventSigner` | `undefined` | Required for unsigned events. `(params) => Promise<NostrEvent>` |
| `optimistic` | `boolean` | `false` | Add to store immediately after signing, before relay confirmation |
| `on` | `{ relays?: string[] }` | `undefined` | Relay targeting |

### Returns

`Observable<OkPacketLike>` — each relay's OK/NG response (`{ ok: boolean; from: string }`).

### Example

```typescript
// Pre-signed event
sendEvent(rxNostr, store, signedEvent, { optimistic: true }).subscribe((pkt) => {
  console.log(`${pkt.from}: ${pkt.ok ? 'ok' : 'failed'}`);
});

// Unsigned event — signer signs it before sending
sendEvent(rxNostr, store, { kind: 1, content: 'Hello!' }, {
  signer: nip07Signer(),
  optimistic: true,
}).subscribe();
```

### Signing Flow

1. Signed event (`id` + `sig` present) → used as-is
2. Unsigned event → `signer(params)` called → signed event obtained
3. If `optimistic: true` → `store.add(signedEvent)` before send
4. `rxNostr.send(signedEvent)` called

If signer fails or is missing for unsigned events, `SigningError` is thrown.

# castEvent

```typescript
import { castEvent } from '@ikuradon/auftakt/sync';
```

## `castEvent(rxNostr, store, eventParams, options?)`

Sign (if needed) and cast an event via rx-nostr. Returns a Promise that resolves when at least one relay accepts.

### Parameters

Same as `sendEvent`, but `rxNostr` must have `cast()` (`RxNostrCastLike`).

### Returns

`Promise<void>` — resolves when at least one relay receives the event.

### Example

```typescript
// Fire and forget
await castEvent(rxNostr, store, signedEvent);

// With signing + optimistic
await castEvent(rxNostr, store, { kind: 1, content: 'Hello!' }, {
  signer: nip07Signer(),
  optimistic: true,
});
```

### When to use send vs cast

| | `sendEvent` | `castEvent` |
|---|---|---|
| Return | `Observable<OkPacketLike>` | `Promise<void>` |
| Relay feedback | Per-relay OK/NG | At least one relay reached |
| Use case | UI showing per-relay status | Fire-and-forget, quick publish |

# SigningError

```typescript
import { SigningError } from '@ikuradon/auftakt/sync';
```

Thrown when:
- Unsigned event is passed without a `signer`
- The `signer` function throws an error

```typescript
try {
  await castEvent(rxNostr, store, unsignedEvent, { signer });
} catch (err) {
  if (err instanceof SigningError) {
    console.error('Signing failed:', err.cause);
  }
}
```

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

## dexieBackend

```typescript
import { dexieBackend } from '@ikuradon/auftakt/backends/dexie';
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dbName` | `string` | `'auftakt'` | IndexedDB database name |

Dexie.js v4 を使用した IndexedDB バックエンド。strfry 風のスキーマ設計とクエリヒューリスティックを実装。削除追跡・ネガティブキャッシュは専用テーブルに永続化されます。

詳細は [バックエンドガイド](/guide/backends) を参照。

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
  | 'ephemeral'  // Kind 20000-29999, not stored
  | 'rejected';  // Structure validation failed or size exceeded
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
  indexedTags?: string[];   // default: all tags (NIP-01 compliant)
  maxEventSize?: number;    // JSON.stringify(event).length limit, undefined = unlimited
}
```
