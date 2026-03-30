# Getting Started

## Install

```bash
pnpm add @ikuradon/auftakt
# peer dependencies
pnpm add rx-nostr rxjs
```

## Quick Start

```typescript
import { createEventStore } from '@ikuradon/auftakt';
import { indexedDBBackend } from '@ikuradon/auftakt/backends/indexeddb';
import { connectStore, createSyncedQuery } from '@ikuradon/auftakt/sync';
import { createRxNostr } from 'rx-nostr';
import { verifier } from '@rx-nostr/crypto';

// 1. Create store
const store = createEventStore({
  backend: indexedDBBackend('my-app'),
});

// 2. Connect rx-nostr
const rxNostr = createRxNostr({ verifier });
rxNostr.setDefaultRelays(['wss://relay.damus.io']);

const disconnect = connectStore(rxNostr, store, {
  filter: (event) => event.kind !== 4, // exclude DMs
  reconcileDeletions: true,
});

// 3. Reactive query
const { events$, status$, dispose } = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [1], authors: ['pubkey1'] },
  strategy: 'dual',
});

events$.subscribe(events => console.log(`${events.length} events`));
status$.subscribe(status => console.log(status));
// 'cached' → 'fetching' → 'live'
```

## What is Auftakt?

**Auftakt** (German: "upbeat") is a musical term for the note before the downbeat. In the same way, auftakt serves cached data before the relay responds.

It's a reactive event store designed specifically for [rx-nostr](https://github.com/penpenpng/rx-nostr). It handles:

- **NIP semantics** — Replaceable, Addressable, Ephemeral, Deletion, Expiration
- **Reactive queries** — `Observable<CachedEvent[]>` that auto-update
- **Cache-aware fetching** — Only fetches what's not already cached
- **Multiple backends** — Memory, IndexedDB, or cached wrapper

## Next Steps

- [Core Concepts](/guide/core-concepts) — Architecture and key ideas
- [Backends](/guide/backends) — Memory, IndexedDB, cached
- [Svelte Integration](/guide/svelte) — Using with SvelteKit
- [API Reference](/api/store) — Full API docs
