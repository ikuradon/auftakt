---
layout: home
hero:
  name: '@ikuradon/auftakt'
  text: 'rx-nostr 専用リアクティブイベントストア'
  tagline: リレーが応答する前にキャッシュがデータを返す。
  actions:
    - theme: brand
      text: はじめに
      link: /guide/getting-started
    - theme: alt
      text: API リファレンス
      link: /reference/api
    - theme: alt
      text: GitHub
      link: https://github.com/ikuradon/auftakt
features:
  - title: NIP セマンティクス内蔵
    details: Replaceable, Addressable, Ephemeral, Kind 5 削除, NIP-40 有効期限 — すべて store.add() が自動処理。
  - title: リアクティブクエリ
    details: Observable<CachedEvent[]> がストア変更時に再発行。逆引きインデックスとマイクロバッチで高速。
  - title: プラガブルバックエンド
    details: Memory（LRU + kind 別バジェット）、Dexie（strfry 風スキーマ + 永続削除追跡）、cachedBackend（read-through キャッシュ）。
  - title: rx-nostr ネイティブ
    details: connectStore() でグローバルフィード、createSyncedQuery() で REQ ライフサイクルとキャッシュ対応 since。
---
