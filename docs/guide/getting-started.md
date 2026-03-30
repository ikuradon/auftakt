# はじめに

## auftakt とは

auftakt は [rx-nostr](https://github.com/penpenpng/rx-nostr) 専用のリアクティブイベントストアです。Nostr クライアントのキャッシュボイラープレートを一掃し、NIP セマンティクス（Replaceable / Addressable / Deletion / Expiration）をストレージ層に内蔵します。

## インストール

```bash
pnpm add @ikuradon/auftakt
```

peer dependencies:

```bash
pnpm add rx-nostr rxjs
```

## クイックスタート

```typescript
import { createEventStore } from '@ikuradon/auftakt';
import { memoryBackend } from '@ikuradon/auftakt/backends/memory';
import { connectStore, createSyncedQuery } from '@ikuradon/auftakt/sync';
import { createRxNostr } from 'rx-nostr';

// 1. ストア作成
const store = createEventStore({
  backend: memoryBackend(),
});

// 2. rx-nostr と接続
const rxNostr = createRxNostr({ verifier: async () => true });
rxNostr.setDefaultRelays(['wss://relay.damus.io']);
const disconnect = connectStore(rxNostr, store);

// 3. リアクティブクエリ
const { events$, status$ } = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [1], limit: 50 },
  strategy: 'dual',
});

events$.subscribe((events) => {
  console.log(`${events.length} 件のイベント`);
});

status$.subscribe((status) => {
  console.log(`ステータス: ${status}`);
  // 'cached' → 'fetching' → 'live'
});
```

## 主な機能

| 機能 | 説明 |
|------|------|
| **NIP 自動処理** | Replaceable, Addressable, Ephemeral, Kind 5 削除, NIP-40 有効期限 |
| **リアクティブクエリ** | `Observable<CachedEvent[]>` — ストア変更時に自動再発行 |
| **プラガブルバックエンド** | Memory, IndexedDB, cached（read-through ラッパー） |
| **REQ ライフサイクル管理** | backward / forward / dual 戦略、キャッシュ対応 since |
| **REQ 重複排除** | 同一フィルタの backward REQ を共有（参照カウント方式） |
| **イベント検証** | 構造バリデーション + サイズ制限（署名検証は呼び出し側の責務） |

## 次のステップ

- [チュートリアル: ゼロから始める](/guide/tutorial-new) — rx-nostr も初めての方向け
- [チュートリアル: rx-nostr に追加する](/guide/tutorial-existing) — 既存アプリにキャッシュ層を追加
- [コアコンセプト](/guide/core-concepts) — store.add() のフローと NIP セマンティクス
- [バックエンド](/guide/backends) — Memory / IndexedDB / cached の使い分け
- [API リファレンス](/reference/api) — 全 API の詳細
