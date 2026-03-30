# Core Concepts

## Architecture

```
                createAllEventObservable()
rx-nostr ──────────────────────────────────→ store.add()
     ↑                                          │
     │ REQ management                      NostrEventStore
     │                                    (NIP semantics)
     │                                          │
 SyncHelper --- emit(filter) --> store.query(filter) --> events$
     │
     └── backward complete callback ──→ EOSE → status$
```

## Responsibility Boundary

| Component | Role |
|-----------|------|
| `connectStore()` | Feeds all events from rx-nostr into the store via `createAllEventObservable()` |
| `createSyncedQuery()` | Manages REQ lifecycle (backward/forward/emit) + exposes `store.query()` results as `events$`. Does NOT call `store.add()` |
| `store.fetchById()` | Calls `store.add()` itself (independent of connectStore) |

**Prerequisite:** `connectStore()` must be called before `createSyncedQuery()`. Without it, SyncedQuery's REQ responses won't reach the store.

## NIP Semantics

`store.add()` automatically handles:

| Event Type | Kind Range | Behavior |
|-----------|-----------|----------|
| Regular | 1-9999, etc. | Stored as-is |
| Replaceable | 0, 3, 10000-19999 | Only latest by `(pubkey, kind)` kept |
| Addressable | 30000-39999 | Only latest by `(kind, pubkey, d-tag)` kept |
| Ephemeral | 20000-29999 | Rejected (not stored) |
| Deletion (kind:5) | 5 | Marks referenced events as deleted (pubkey verified) |
| Expired (NIP-40) | Any with expiration tag | Rejected on add, excluded on query |

### Pending Deletions

When a kind:5 event arrives before its target (common with BackwardReq which sends events in descending `created_at` order), the deletion is held in `pendingDeletions`. When the target event arrives later, it's automatically verified and deleted.

## Reactive Queries

`store.query()` returns `Observable<CachedEvent[]>` that:

- Emits current results immediately on subscribe
- Re-emits when store changes affect the query
- Supports full Nostr filter format (`ids`, `kinds`, `authors`, `since`, `until`, `limit`, `#e`, `#p`, etc.)
- `since`/`until`/`limit` queries are reactive — new matching events trigger re-emit
- Automatically cleaned up on unsubscribe

### Optimization

- **Micro-batching:** Multiple rapid `add()` calls trigger a single query re-evaluation via `queueMicrotask()`
- **Reverse index:** Only queries whose kind/author match the added event are re-evaluated
- **Differential update:** For regular event additions, results are updated in-place without re-querying the backend

## SyncedQuery Strategies

| Strategy | Flow | Use Case |
|----------|------|----------|
| `'backward'` | cached → fetching → complete | One-time data fetch |
| `'forward'` | cached → live | Real-time subscription |
| `'dual'` | cached → fetching → live | Fetch history + subscribe to new |

## Security Model

- Events via `connectStore()`: Verified by rx-nostr's verifier. Store does not re-verify.
- Events via direct `store.add()`: Caller guarantees verification.
- Events from IndexedDB: Trusted cache (same-origin policy protection).
