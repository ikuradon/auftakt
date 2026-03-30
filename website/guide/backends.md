# Backends

## Memory Backend

```typescript
import { memoryBackend } from '@ikuradon/auftakt/backends/memory';

const backend = memoryBackend(); // no limits

const backend = memoryBackend({
  maxEvents: 10000,
  eviction: {
    strategy: 'lru',
    budgets: {
      0: { max: 2000 },      // profiles
      1: { max: 5000 },      // notes
      7: { max: 3000 },      // reactions
      default: { max: 2000 },
    },
  },
});
```

### LRU Eviction

When `maxEvents` is exceeded on `store.add()`:

1. Check the added event's kind budget — evict within kind if over budget
2. Check global `maxEvents` — evict LRU across all kinds
3. Pinned events (in active query results) are protected via access-time tracking

Access time is updated on `put()`, `get()`, and `query()` results.

## IndexedDB Backend

```typescript
import { indexedDBBackend } from '@ikuradon/auftakt/backends/indexeddb';

const backend = indexedDBBackend('my-app');

// With batch writes
const backend = indexedDBBackend('my-app', { batchWrites: true });
```

### Features

- **Compound indexes:** `[pubkey, kind]`, `[kind, pubkey, d_tag]`, `[kind, created_at]`, tag multiEntry
- **ObjectStore separation:** `events`, `deleted`, `negative_cache`
- **Batch writes:** `queueMicrotask()` buffering for multiple rapid puts
- **SSR fallback:** Auto-falls back to memory backend when `typeof indexedDB === 'undefined'`
- **Error policy:** Write failures log a warning but don't throw

## Cached Backend (Read-Through)

```typescript
import { cachedBackend } from '@ikuradon/auftakt/backends/cached';
import { indexedDBBackend } from '@ikuradon/auftakt/backends/indexeddb';

const backend = cachedBackend(indexedDBBackend('my-app'), {
  maxCached: 5000,
});
```

Wraps any backend with an in-memory LRU cache:

| Operation | Behavior |
|-----------|----------|
| `put()` | Write-through (both cache + inner) |
| `get()` | Cache first → miss → inner → populate cache |
| `query()` | Always inner → populate cache with results |
| `delete()` | Both cache + inner |

**Lazy hydration:** No startup full-load from IndexedDB. Events are cached on access.
