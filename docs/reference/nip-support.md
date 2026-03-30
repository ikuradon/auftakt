# NIP Support

## Event Classification

| Event Type | Kind Range | store.add() Behavior |
|-----------|-----------|---------------------|
| Regular | 1-9999 (excluding below) | Stored as-is |
| Replaceable | 0, 3, 10000-19999 | Only latest by `(pubkey, kind)` kept |
| Addressable | 30000-39999 | Only latest by `(kind, pubkey, d-tag)` kept |
| Ephemeral | 20000-29999 | Rejected (not stored) |

## Supported NIPs

| NIP | Feature | Implementation |
|-----|---------|---------------|
| NIP-01 | Event kinds, filters, tag queries | `nip-rules.ts`, `filter-matcher.ts` |
| NIP-01 | Replaceable events (kind 0, 3, 10000-19999) | `store.add()` step 5 |
| NIP-01 | Addressable events (kind 30000-39999) | `store.add()` step 6, d-tag `""` fallback |
| NIP-09 | Event deletion (kind 5) | `store.add()` step 4, e-tag + a-tag |
| NIP-09 | Pubkey verification on deletion | Author match required |
| NIP-09 | Pending deletions (out-of-order arrival) | `pendingDeletions` Map with TTL |
| NIP-33 | Parameterized replaceable events | Merged into NIP-01 addressable handling |
| NIP-40 | Event expiration | `isExpired()` check on add + query |

## Replacement Rules

When a new event arrives for the same replaceable/addressable key:

1. Compare `created_at` — higher wins
2. Tiebreaker: lower event `id` (lexicographic) wins
3. Loser is discarded (not stored)

## Deletion Flow

### Online (during subscription)

```
kind:5 arrives → extract e-tags and a-tags
  → For each e-tag: find target in store, verify pubkey match → mark deleted
  → For each a-tag: find addressable event, verify pubkey + created_at → mark deleted
  → Target not found → register in pendingDeletions (TTL: 5min, max: 10000)
```

### Pending (target arrives later)

```
Regular event arrives → check pendingDeletions
  → Match found + pubkey verified → mark deleted immediately
  → No match → store normally
```

### Startup Reconciliation

```typescript
connectStore(rxNostr, store, { reconcileDeletions: true });
// Fetches kind:5 events for all cached event IDs (chunked by 50)
```

## Deletion of Deletion Events

Per NIP-09, deletion events (kind:5) **cannot be deleted by other kind:5 events**. This is a protocol violation. auftakt does not support this — a kind:5 event referencing another kind:5 via e-tag will have no effect on the referenced deletion.

## Tag Indexing

All single-letter tags are indexed by default (NIP-01 compliant). Restrict with:

```typescript
createEventStore({
  backend: memoryBackend(),
  indexedTags: ['e', 'p', 't', 'a', 'k'], // only these tags
});
```
