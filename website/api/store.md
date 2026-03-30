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
