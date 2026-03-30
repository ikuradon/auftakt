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
