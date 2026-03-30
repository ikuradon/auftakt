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
