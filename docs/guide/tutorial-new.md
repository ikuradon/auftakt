# チュートリアル: ゼロから始める

rx-nostr も auftakt も初めての方向け。簡単な Nostr クライアントを作りながら、キャッシュ付きイベント取得の仕組みを学びます。

## 前提

- Node.js 24 以上
- TypeScript プロジェクトが `pnpm init` で初期化済み

## 1. パッケージのインストール

```bash
pnpm add @ikuradon/auftakt rx-nostr rxjs
```

| パッケージ | 役割 |
|-----------|------|
| `rx-nostr` | Nostr リレーとの通信（WebSocket + REQ/EVENT 管理） |
| `rxjs` | リアクティブプログラミング基盤 |
| `@ikuradon/auftakt` | イベントストア + NIP セマンティクス + クエリ |

## 2. rx-nostr の初期化

まず rx-nostr のインスタンスを作り、使用するリレーを設定します。

```typescript
// src/nostr.ts
import { createRxNostr } from 'rx-nostr';

export const rxNostr = createRxNostr({
  // 本番では nostr-tools の verifyEvent を使う
  verifier: async () => true,
});

rxNostr.setDefaultRelays([
  'wss://relay.damus.io',
  'wss://nos.lol',
]);
```

この時点では rx-nostr は「リレーと通信できる」だけの状態です。受け取ったイベントをどこに保存するか、重複をどう排除するかは自分で管理する必要があります。ここが auftakt の出番です。

## 3. イベントストアの作成

```typescript
// src/store.ts
import { createEventStore } from '@ikuradon/auftakt';
import { memoryBackend } from '@ikuradon/auftakt/backends/memory';

export const store = createEventStore({
  backend: memoryBackend(),
});
```

`memoryBackend()` はすべてをメモリに保持するバックエンドです。ブラウザアプリで永続化が必要なら `indexedDBBackend` を使います（[バックエンド](/guide/backends)参照）。

## 4. rx-nostr とストアを接続する

```typescript
// src/main.ts
import { rxNostr } from './nostr.js';
import { store } from './store.js';
import { connectStore } from '@ikuradon/auftakt/sync';

// rx-nostr が受け取る全イベントをストアに流し込む
const disconnect = connectStore(rxNostr, store);
```

`connectStore()` は rx-nostr の `createAllEventObservable()` を購読し、受信した全イベントを `store.add()` に渡します。NIP セマンティクス（Replaceable 置換、Kind 5 削除、NIP-40 有効期限など）はストアが自動処理します。

**これだけで、イベントの重複排除・置換・削除がすべて自動化されます。**

## 5. タイムラインを取得する

```typescript
// src/main.ts（続き）
import { createSyncedQuery } from '@ikuradon/auftakt/sync';

const { events$, status$ } = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [1], limit: 50 },
  strategy: 'dual',
});
```

### strategy の選び方

| strategy | 動作 | ユースケース |
|----------|------|-------------|
| `'backward'` | 過去のイベントを取得して完了 | プロフィール表示、検索結果 |
| `'forward'` | 新着イベントをリアルタイム受信 | 通知フィード |
| `'dual'` | 過去分を取得 → リアルタイムに切り替え | タイムライン |

### ステータスの遷移

```typescript
status$.subscribe((status) => {
  switch (status) {
    case 'cached':    // ストア内のキャッシュを表示中
    case 'fetching':  // リレーからイベントを取得中
    case 'live':      // リアルタイム受信中
    case 'complete':  // 過去分の取得完了（backward のみ）
  }
});
```

## 6. イベントを表示する

```typescript
events$.subscribe((events) => {
  console.clear();
  console.log(`--- タイムライン (${events.length} 件) ---`);
  for (const cached of events.slice(0, 10)) {
    const { event } = cached;
    const time = new Date(event.created_at * 1000).toLocaleTimeString();
    const author = event.pubkey.slice(0, 8) + '...';
    console.log(`[${time}] ${author}: ${event.content.slice(0, 80)}`);
  }
});
```

`events$` は `Observable<CachedEvent[]>` です。ストアにイベントが追加されるたびに、最新の結果が再発行されます。`subscribe` 内のコードが自動的に再実行されるので、手動で再クエリする必要はありません。

## 7. プロフィールを取得する

kind:0 は Replaceable イベントです。ストアが `(pubkey, kind)` で最新版だけを保持するので、特別な処理は不要です。

```typescript
const { events$: profile$ } = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [0], authors: [targetPubkey] },
  strategy: 'backward',
});

profile$.subscribe((profiles) => {
  if (profiles.length > 0) {
    const meta = JSON.parse(profiles[0].event.content);
    console.log(`名前: ${meta.name}`);
    console.log(`自己紹介: ${meta.about}`);
  }
});
```

## 8. 後片付け

```typescript
// SyncedQuery の破棄
syncedQuery.dispose();

// rx-nostr との接続解除
disconnect();

// ストア全体の破棄（全クエリの subscriber を complete）
store.dispose();

// rx-nostr の破棄
rxNostr.dispose();
```

## 完成コード

```typescript
import { createRxNostr } from 'rx-nostr';
import { createEventStore } from '@ikuradon/auftakt';
import { memoryBackend } from '@ikuradon/auftakt/backends/memory';
import { connectStore, createSyncedQuery } from '@ikuradon/auftakt/sync';

// 初期化
const rxNostr = createRxNostr({ verifier: async () => true });
rxNostr.setDefaultRelays(['wss://relay.damus.io', 'wss://nos.lol']);

const store = createEventStore({ backend: memoryBackend() });
const disconnect = connectStore(rxNostr, store);

// タイムライン
const timeline = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [1], limit: 50 },
  strategy: 'dual',
});

timeline.events$.subscribe((events) => {
  console.log(`${events.length} 件のイベント`);
  for (const { event } of events.slice(0, 5)) {
    console.log(`  ${event.pubkey.slice(0, 8)}: ${event.content.slice(0, 60)}`);
  }
});

timeline.status$.subscribe((s) => console.log(`ステータス: ${s}`));

// 終了処理
process.on('SIGINT', () => {
  timeline.dispose();
  disconnect();
  store.dispose();
  rxNostr.dispose();
  process.exit(0);
});
```

## 次のステップ

- [コアコンセプト](/guide/core-concepts) — store.add() の内部フローを理解する
- [バックエンド](/guide/backends) — IndexedDB で永続化する
- [パターン集](/guide/patterns) — スレッド、リアクション、optimistic publish
