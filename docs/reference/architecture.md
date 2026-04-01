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
| `sendEvent()` / `castEvent()` | Sign + send/cast events with optimistic update | Yes (when optimistic) |

## Internal Modules

```
src/
├── core/
│   ├── store.ts              # Main store: add(), query(), getSync(), fetchById(), changes$
│   ├── nip-rules.ts          # Event classification, replacement comparison
│   ├── filter-matcher.ts     # Nostr filter ↔ event matching
│   ├── query-manager.ts      # Reactive query registry, reverse index, diff update, micro-batching
│   └── snapshot.ts           # localStorage save/load for fast paint
├── backends/
│   ├── interface.ts          # StorageBackend contract + StoredEvent, DeletedRecord, ReplaceDeletionRecord
│   ├── memory.ts             # In-memory with LRU eviction + kind budgets + deletion tracking
│   ├── dexie.ts              # Dexie.js v4 (strfry-inspired schema, query heuristic, persistent deletion)
│   └── cached.ts             # Read-through cache wrapper (lazy hydration)
├── sync/
│   ├── synced-query.ts       # REQ lifecycle, strategies, REQ dedup, cache-aware since
│   ├── global-feed.ts        # connectStore + reconcileDeletions + filter mismatch warn
│   ├── deletion-reconcile.ts # Startup kind:5 integrity check
│   ├── since-tracker.ts      # Latest cached timestamp for since adjustment
│   └── publish.ts            # sendEvent / castEvent with signing + optimistic store
└── adapters/
    └── svelte.ts             # Svelte readable store adapter
```

## Data Flow

### Event Addition (store.add)

```
0.   Validate structure → reject if invalid
1.   Ephemeral? → reject
1.5  backend.isDeleted()? → reject (persistent deletion record)
2.   Duplicate? → update seenOn, return
3.   NIP-40 expired? → reject
4.   Kind 5? → persist deletion records (markDeleted/markReplaceDeletion), delete targets
5.   Replaceable? → compare created_at, replace if newer → check isDeleted
6.   Addressable? → compare (kind, pubkey, d-tag), replace → check isDeleted + getReplaceDeletion
7.   Regular → store
8.   Check backend.isDeleted → handle out-of-order arrival
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
