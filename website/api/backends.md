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
