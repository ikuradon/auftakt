# Svelte Integration

## Setup

```typescript
import { createSvelteQuery } from '@ikuradon/auftakt/adapters/svelte';
```

## createSvelteQuery

Wraps `createSyncedQuery` and returns Svelte-compatible readable stores.

```svelte
<script>
  import { createSvelteQuery } from '@ikuradon/auftakt/adapters/svelte';

  const { events, status, emit, dispose } = createSvelteQuery(rxNostr, store, {
    filter: { kinds: [1], authors: followList },
    strategy: 'dual',
  });

  // Svelte 4: $events, $status
  // Svelte 5: use with $derived for filtering
  const filtered = $derived($events.filter(e => !isMuted(e.event.pubkey)));
</script>

{#if $status === 'fetching'}
  <Skeleton />
{/if}

{#each $events as cached}
  <Note event={cached.event} relays={cached.seenOn} />
{/each}
```

## toReadable

Convert any RxJS Observable to a Svelte readable store:

```typescript
import { toReadable } from '@ikuradon/auftakt/adapters/svelte';

const events = toReadable(store.query({ kinds: [0], authors: [pubkey] }));
// Use as $events in Svelte template
```

## SvelteKit SSR

IndexedDB is not available during SSR. The `indexedDBBackend` auto-falls back to memory. Initialize the store in browser-only context:

```typescript
import { browser } from '$app/environment';
import { onMount } from 'svelte';

let store;
onMount(() => {
  store = createEventStore({ backend: indexedDBBackend('my-app') });
  connectStore(rxNostr, store);
});
```

## Mute Filtering

```svelte
<script>
  const { events } = createSvelteQuery(rxNostr, store, {
    filter: { kinds: [1] },
    strategy: 'dual',
  });

  // $derived automatically re-evaluates when muteList changes
  const filtered = $derived(
    $events.filter(e => !muteList.has(e.event.pubkey))
  );
</script>
```
