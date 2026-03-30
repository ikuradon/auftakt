# パターン集

## プロフィール取得

kind:0 はユーザーごとに 1 件の Replaceable イベント。`getSync` でキャッシュ優先、`fetchById` でリレーフォールバック:

```typescript
// キャッシュから即座に取得
const profiles = await store.getSync({
  kinds: [0],
  authors: [pubkey],
});

if (profiles.length > 0) {
  const profile = JSON.parse(profiles[0].event.content);
}
```

## タイムラインの構築

`createSyncedQuery` の `dual` 戦略で、キャッシュ → 過去分取得 → リアルタイム更新:

```typescript
const { events$, status$ } = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [1], authors: followList, limit: 100 },
  strategy: 'dual',
});

// status$: 'cached' → 'fetching' → 'live'
```

## スレッドの読み込み

ルートイベント + リプライを取得:

```typescript
// ルートイベント
const root = await store.fetchById(rootEventId, {
  fetch: (id) => fetchFromRelay(rxNostr, id),
  negativeTTL: 60_000,
});

// リプライ（リアクティブ）
const replies$ = store.query({
  kinds: [1],
  '#e': [rootEventId],
});
```

## リアクション数のカウント

```typescript
const reactions$ = store.query({
  kinds: [7],
  '#e': [targetEventId],
});

reactions$.subscribe((reactions) => {
  const likes = reactions.filter((r) => r.event.content === '+');
  console.log(`${likes.length} いいね`);
});
```

## connectStore のフィルタリング

DM（kind:4）を除外:

```typescript
const disconnect = connectStore(rxNostr, store, {
  filter: (event) => event.kind !== 4,
});
```

## staleTime でリクエストを抑制

同じクエリを短時間に繰り返さない:

```typescript
const { events$ } = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [0], authors: [pubkey] },
  strategy: 'backward',
  staleTime: 5 * 60_000, // 5分以内なら REQ をスキップ
});
```

## スナップショット（高速初期表示）

localStorage にストア状態を保存し、次回起動時に即座に復元:

```typescript
import { saveSnapshot, loadSnapshot } from '@ikuradon/auftakt';

// 保存
await saveSnapshot(store, { key: 'auftakt-cache' });

// 復元（store 作成直後）
await loadSnapshot(store, { key: 'auftakt-cache' });
```

## Optimistic Publish

イベントをリレー確認前にストアに追加:

```typescript
import { publishEvent } from '@ikuradon/auftakt/sync';

const ok$ = publishEvent(rxNostr, store, signedEvent, {
  optimistic: true, // 即座にストアに追加
});

ok$.subscribe((result) => {
  if (!result.ok) {
    console.warn('リレーが拒否:', result.notice);
  }
});
```

## dispose のベストプラクティス

`store.dispose()` はすべてのクエリ subscriber を complete します。コンポーネントのライフサイクルに合わせて呼び出してください:

```typescript
// SyncedQuery
const { dispose } = createSyncedQuery(rxNostr, store, options);
// コンポーネント破棄時
dispose();

// ストア全体の破棄
store.dispose(); // changes$ + 全クエリの subscriber を complete
```
