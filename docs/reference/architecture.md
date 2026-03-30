# Architecture

## System Overview

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

## Component Responsibilities

| Component | Role | Calls store.add()? |
|-----------|------|--------------------|
| `connectStore()` | Feeds all rx-nostr events into the store | Yes (fire-and-forget) |
| `createSyncedQuery()` | Manages REQ lifecycle + reactive queries | No (depends on connectStore) |
| `store.fetchById()` | Single event fetch with relay fallback | Yes (self-contained) |
| `publishEvent()` | Publishes events with optimistic update | Yes (when optimistic) |

## Internal Modules

```
src/
├── core/
│   ├── store.ts              # Main store: add(), query(), getSync(), fetchById(), changes$
│   ├── nip-rules.ts          # Event classification, replacement comparison
│   ├── filter-matcher.ts     # Nostr filter ↔ event matching
│   ├── query-manager.ts      # Reactive query registry, reverse index, diff update, micro-batching
│   ├── negative-cache.ts     # TTL-based "not found" cache
│   └── snapshot.ts           # localStorage save/load for fast paint
├── backends/
│   ├── interface.ts          # StorageBackend contract
│   ├── memory.ts             # In-memory with LRU eviction + kind budgets
│   ├── indexeddb.ts          # IndexedDB with batch writes, SSR fallback, error policy
│   └── cached.ts             # Read-through cache wrapper (lazy hydration)
├── sync/
│   ├── synced-query.ts       # REQ lifecycle, strategies, REQ dedup, cache-aware since
│   ├── global-feed.ts        # connectStore + reconcileDeletions + filter mismatch warn
│   ├── deletion-reconcile.ts # Startup kind:5 integrity check
│   ├── since-tracker.ts      # Latest cached timestamp for since adjustment
│   └── publish.ts            # publishEvent with optimistic store update
└── adapters/
    └── svelte.ts             # Svelte readable store adapter
```

## Data Flow

### Event Addition (store.add)

```
1.   Ephemeral? → reject
1.5  In deletedIds? → reject (race condition prevention)
2.   Duplicate? → update seenOn, return
3.   NIP-40 expired? → reject
4.   Kind 5? → process e-tag/a-tag deletions, register pendingDeletions
5.   Replaceable? → compare created_at, replace if newer
6.   Addressable? → compare (kind, pubkey, d-tag), replace if newer
7.   Regular → store
8.   Check pendingDeletions → auto-delete if pending
9.   Notify reactive queries (reverse index → micro-batch → diff update)
```

### Query Optimization Pipeline

```
store.add(event)
  → Reverse index: kindIndex ∪ authorIndex ∪ wildcardSet → candidate queries
  → matchesFilter() → dirty set
  → queueMicrotask() → flush (batched)
  → Diff update (add-only) or full backend query (delete/replace)
  → BehaviorSubject.next() → UI update
```
