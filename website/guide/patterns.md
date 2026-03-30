# Patterns

## Multiple Filter Merge

When you need dynamic filter addition (e.g., podcast guid resolution):

```typescript
import { combineLatest } from 'rxjs';
import { startWith, map } from 'rxjs/operators';

const q1 = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [1111], '#I': ['podcast:feed:xxx'] },
  strategy: 'dual',
});

const q2 = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [1111], '#I': ['podcast:guid:yyy'] },
  strategy: 'dual',
});

const merged$ = combineLatest([
  q1.events$,
  q2.events$.pipe(startWith([])),
]).pipe(
  map(([a, b]) => {
    const seen = new Set();
    return [...a, ...b].filter(e => {
      if (seen.has(e.event.id)) return false;
      seen.add(e.event.id);
      return true;
    });
  }),
);
```

## TanStack Query Bridge

Use `store.changes$` and `store.getSync()` for integration:

```typescript
// Bridge store changes to TanStack Query
store.changes$.subscribe(change => {
  if (change.event.kind === 0) {
    queryClient.invalidateQueries({ queryKey: ['metadata', change.event.pubkey] });
  }
  if (change.type === 'deleted') {
    queryClient.removeQueries({ queryKey: ['note', change.event.id] });
  }
});

// Use store as queryFn
const query = createQuery({
  queryKey: ['metadata', pubkey],
  queryFn: () => store.getSync({ kinds: [0], authors: [pubkey] }),
});
```

## localStorage Snapshot

Speed up initial paint by saving/loading critical data:

```typescript
import { saveSnapshot, loadSnapshot } from '@ikuradon/auftakt';

// On session end
await saveSnapshot(store, {
  key: 'auftakt-snapshot',
  filter: { kinds: [0], authors: followList },
});

// On startup (before connectStore)
await loadSnapshot(store, { key: 'auftakt-snapshot' });
```

## Mute Filtering (RxJS)

```typescript
import { combineLatest } from 'rxjs';
import { map } from 'rxjs/operators';

const filtered$ = combineLatest([events$, muteList$]).pipe(
  map(([events, muted]) => events.filter(e => !muted.has(e.event.pubkey)))
);
```

## Relay-Specific Queries

```typescript
const { events$ } = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [1] },
  strategy: 'forward',
  on: { relays: ['wss://specific.relay.com'] },
});
```
