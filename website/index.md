---
layout: home
hero:
  name: "@ikuradon/auftakt"
  text: "Reactive Event Store for rx-nostr"
  tagline: Cache serves data before the relay responds.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: API Reference
      link: /api/store
    - theme: alt
      text: GitHub
      link: https://github.com/ikuradon/auftakt
features:
  - title: NIP-Compliant
    details: Replaceable, Addressable, Ephemeral, Kind 5 deletion, NIP-40 expiration — all handled automatically.
  - title: Reactive Queries
    details: Observable<CachedEvent[]> that re-emit when the store changes. Micro-batched for performance.
  - title: Pluggable Backends
    details: Memory (with LRU), IndexedDB (with batch writes), or cached wrapper for read-through caching.
  - title: rx-nostr Native
    details: connectStore() for global feed, createSyncedQuery() for REQ lifecycle with cache-aware since.
---
