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
