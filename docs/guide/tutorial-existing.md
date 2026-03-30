# チュートリアル: rx-nostr に追加する

既に rx-nostr で動くアプリケーションがあり、キャッシュ層を追加したい方向けのガイドです。

## 典型的な Before

rx-nostr を直接使うアプリでは、こんなコードをよく見かけます:

```typescript
import { createRxNostr, createRxForwardReq, createRxBackwardReq } from 'rx-nostr';

const rxNostr = createRxNostr({ verifier });
rxNostr.setDefaultRelays(relays);

// タイムライン取得
const backReq = createRxBackwardReq();
rxNostr.use(backReq).subscribe((packet) => {
  // 手動で重複チェック
  if (!seen.has(packet.event.id)) {
    seen.add(packet.event.id);
    events.push(packet.event);
    events.sort((a, b) => b.created_at - a.created_at);
    renderTimeline(events);
  }
});
backReq.emit({ kinds: [1], limit: 50 });

// リアルタイム更新
const fwdReq = createRxForwardReq();
rxNostr.use(fwdReq).subscribe((packet) => {
  if (!seen.has(packet.event.id)) {
    seen.add(packet.event.id);
    events.unshift(packet.event);
    renderTimeline(events);
  }
});
fwdReq.emit({ kinds: [1] });
```

### このアプローチの問題点

| 問題 | 詳細 |
|------|------|
| **重複排除が手動** | `seen` Set を自分で管理 |
| **Replaceable 未対応** | kind:0 が複数届くと古いプロフィールが残る |
| **削除未対応** | kind:5 が届いても元イベントが消えない |
| **有効期限未対応** | NIP-40 の `expiration` タグを無視 |
| **リアクティブでない** | 新しいイベントが来るたびに手動で配列操作 + 再描画 |
| **REQ が重複** | 同じフィルタを複数箇所で使うと別々の REQ が発行される |

## Step 1: インストール

```bash
pnpm add @ikuradon/auftakt
```

rx-nostr と rxjs は既にあるはずです。なければ:

```bash
pnpm add rx-nostr rxjs
```

## Step 2: ストア作成 + 接続

既存の `createRxNostr()` はそのまま使えます。ストアを作って接続するだけです。

```typescript
import { createEventStore } from '@ikuradon/auftakt';
import { memoryBackend } from '@ikuradon/auftakt/backends/memory';
import { connectStore } from '@ikuradon/auftakt/sync';

// 既存の rxNostr インスタンスをそのまま使う
const store = createEventStore({ backend: memoryBackend() });
const disconnect = connectStore(rxNostr, store);
```

`connectStore()` は `rxNostr.createAllEventObservable()` を内部で使い、受信した全イベントを `store.add()` に渡します。**既存の `rxNostr.use()` による購読はそのまま動きます。**

::: tip 既存コードとの共存
`connectStore()` は rx-nostr の既存の購読に影響しません。段階的に移行できます。
:::

## Step 3: 手動イベント管理を置き換える

### Before（手動）

```typescript
const seen = new Set<string>();
const events: NostrEvent[] = [];

rxNostr.use(backReq).subscribe((packet) => {
  if (!seen.has(packet.event.id)) {
    seen.add(packet.event.id);
    events.push(packet.event);
    events.sort((a, b) => b.created_at - a.created_at);
    renderTimeline(events);
  }
});
```

### After（auftakt）

```typescript
import { createSyncedQuery } from '@ikuradon/auftakt/sync';

const { events$, status$ } = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [1], limit: 50 },
  strategy: 'dual', // backward + forward を自動管理
});

events$.subscribe((events) => {
  renderTimeline(events.map((e) => e.event));
});
```

**削除したもの:**
- `seen` Set → ストアが重複排除
- 手動 sort → ストアが `created_at` 降順で返す
- `createRxBackwardReq` + `createRxForwardReq` → `strategy: 'dual'` が両方管理
- `backReq.emit()` + `fwdReq.emit()` → `createSyncedQuery` が自動発行

**追加されたもの:**
- NIP セマンティクス（Replaceable 置換、Kind 5 削除、NIP-40 有効期限）
- REQ 重複排除（同じフィルタは1つの REQ を共有）
- キャッシュ対応 since（2回目以降は差分のみ取得）

## Step 4: プロフィール取得の改善

### Before

```typescript
// kind:0 を取得するが、同じ pubkey の古い/新しいバージョンの管理は自前
rxNostr.use(profileReq).subscribe((packet) => {
  profiles.set(packet.event.pubkey, packet.event);
});
```

### After

```typescript
const { events$: profile$ } = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [0], authors: [pubkey] },
  strategy: 'backward',
});

profile$.subscribe((profiles) => {
  // 常に最新の1件だけ（Replaceable はストアが自動管理）
  if (profiles.length > 0) {
    const meta = JSON.parse(profiles[0].event.content);
    updateProfileUI(meta);
  }
});
```

Replaceable イベント（kind:0）はストアが `(pubkey, kind)` で最新版だけを保持するので、古いバージョンの上書きロジックが不要になります。

## Step 5: 既存の use() 購読を段階的に移行

すべてを一度に置き換える必要はありません。`connectStore()` が動いていれば、以下のように段階的に移行できます:

### まだ移行しない部分

既存の `rxNostr.use()` 購読は引き続き動きます。イベントは `connectStore` 経由でストアにも保存されるため、後から `store.query()` でも取得できます。

```typescript
// 既存コード — そのまま動く
rxNostr.use(someReq).subscribe((packet) => {
  doSomethingCustom(packet);
});

// 同時に、ストアからも同じイベントを取得可能
const events = await store.getSync({ kinds: [1], '#e': [targetId] });
```

### 移行チェックリスト

| 既存コード | auftakt 置き換え |
|-----------|-----------------|
| `createRxBackwardReq` + `use()` + `subscribe` | `createSyncedQuery({ strategy: 'backward' })` |
| `createRxForwardReq` + `use()` + `subscribe` | `createSyncedQuery({ strategy: 'forward' })` |
| backward → forward の手動切り替え | `createSyncedQuery({ strategy: 'dual' })` |
| `Map<string, Event>` による重複排除 | 削除（ストアが自動処理） |
| kind 別の手動振り分けロジック | 削除（`store.add()` が NIP セマンティクスを処理） |
| `rxNostr.send()` + 手動ストア更新 | `publishEvent(rxNostr, store, event, { optimistic: true })` |

## Step 6: 後片付けの整理

### Before

```typescript
// 購読ごとに unsubscribe を管理
const sub1 = rxNostr.use(req1).subscribe(...);
const sub2 = rxNostr.use(req2).subscribe(...);
// 忘れやすい
sub1.unsubscribe();
sub2.unsubscribe();
```

### After

```typescript
// SyncedQuery が内部の購読を一括管理
const timeline = createSyncedQuery(rxNostr, store, options);

// 破棄は1行
timeline.dispose();

// アプリ全体の終了
disconnect();     // connectStore の購読解除
store.dispose();  // 全クエリの subscriber を complete
rxNostr.dispose();
```

## Before / After 比較

### Before: 約40行

```typescript
const seen = new Set<string>();
const events: NostrEvent[] = [];

const backReq = createRxBackwardReq();
rxNostr.use(backReq).subscribe((packet) => {
  if (!seen.has(packet.event.id)) {
    seen.add(packet.event.id);
    events.push(packet.event);
    events.sort((a, b) => b.created_at - a.created_at);
    if (events.length > 50) events.length = 50;
    renderTimeline(events);
  }
});
backReq.emit({ kinds: [1], limit: 50 });

const fwdReq = createRxForwardReq();
rxNostr.use(fwdReq).subscribe((packet) => {
  if (!seen.has(packet.event.id)) {
    seen.add(packet.event.id);
    events.unshift(packet.event);
    if (events.length > 50) events.pop();
    renderTimeline(events);
  }
});
fwdReq.emit({ kinds: [1] });
```

### After: 約10行

```typescript
const store = createEventStore({ backend: memoryBackend() });
const disconnect = connectStore(rxNostr, store);

const { events$ } = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [1], limit: 50 },
  strategy: 'dual',
});

events$.subscribe((events) => {
  renderTimeline(events.map((e) => e.event));
});
```

**得られたもの:** 重複排除、Replaceable 置換、Kind 5 削除、NIP-40 有効期限、REQ 重複排除、キャッシュ対応 since — すべて自動。

## 次のステップ

- [コアコンセプト](/guide/core-concepts) — store.add() の内部フローを理解する
- [バックエンド](/guide/backends) — IndexedDB で永続化する
- [パターン集](/guide/patterns) — スレッド、リアクション、optimistic publish
