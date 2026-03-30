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
