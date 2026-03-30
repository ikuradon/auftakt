# Design Review: @ikuradon/auftakt × Resonote

**Date:** 2026-03-30
**Reviewer:** Claude (コードベース全体の調査に基づく)
**対象Spec:** `2026-03-30-rx-nostr-event-store-design.md`
**対象コードベース:** Resonote (commit 49e4f03)

---

## 1. この機能が必要な理由（コードベースからの実証）

### 1.1 ボイラープレートの実態

現在の Resonote で **手動キャッシュ書き込み (`eventsDB.put()`)** が 8箇所以上に散在:

| ファイル | 箇所 | コンテキスト |
|---------|------|------------|
| `cached-query.svelte.ts` | 2箇所 | fetchById / fetchLatestByFilter |
| `comment-view-model.svelte.ts` | 1箇所 | コメント受信時 |
| `client.ts` | 1箇所 | fetchLatestEvent |
| `wot-fetcher.ts` | 2箇所 | WoT follow list取得 |
| `podcast-resolver.ts` | 1箇所 | NIP-B0 bookmark 受信 |
| `episode-resolver.ts` | 1箇所 | エピソード解決 |

**`rxNostr.use()` のサブスクリプションセットアップ** が 15箇所以上で繰り返される:
- `createRxBackwardReq` + `createRxForwardReq` のインポート
- `.pipe(uniq())` のデデュプ (4ファイル)
- エラーハンドリング + タイムアウト + `sub.unsubscribe()` のクリーンアップ
- `req.emit(filter)` + `req.over()`

**cache-aware `since` 計算** が 3箇所で手動実装:
```typescript
// comment-subscription.ts
const backwardFilters = maxCreatedAt
  ? filters.map((f) => ({ ...f, since: maxCreatedAt + 1 }))
  : filters;
```

→ **auftakt の `connectStore()` + `createSyncedQuery()` で一掃できるのは実証済み。Spec §10 の Before/After 比較は現実的。**

### 1.2 クロスサブスクリプション整合性の問題

現在の kind:5 削除処理は **コメント feature に閉じている**:

- `deletion-rules.ts`: pubkey 検証ロジック
- `comment-view-model.svelte.ts`: `pendingDeletions` Map で未到着イベントの削除を保留
- `comment-subscription.ts`: `startDeletionReconcile()` で起動時のオフライン削除回復

**問題:** notifications、profiles、bookmarks の feature では kind:5 削除の整合性チェックがない。あるサブスクリプションで受信した削除イベントが、別 feature のキャッシュに反映されない。

→ **auftakt の Store レベルでの `deletedIds: Set<string>` + `store.add()` 内の自動削除処理 (Spec §5.1 ステップ4) は、この問題を根本的に解決する。**

---

## 2. Spec への改善提案

### 2.1 [P1] Resonote の既存 IndexedDB 設計を活かす

**現状の event-db.ts のインデックス設計:**
```
pubkey_kind:     [pubkey, kind]       — Replaceable 検索
replace_key:     [kind, pubkey, dtag] — Addressable 検索
kind_created:    [kind, created_at]   — タイムラインクエリ
tag_values:      _tag_values (multiEntry) — タグクエリ
```

**Spec §6.1 のインデックス設計:**
```
pubkey_kind:     [pubkey, kind]
replace_key:     [pubkey, kind, _d_tag]  ← 順序が違う
kind_created_at: [kind, created_at]
tag_index:       _tag_index (multiEntry)
```

**提案:** `replace_key` のキー順序を `[kind, pubkey, dtag]` に統一する（Resonote 実装準拠）。IDB の compound index は prefix matching するため、`kind` が先のほうが「特定 kind の全 addressable」検索に有利。Resonote はこの順序で運用実績がある。

### 2.2 [P1] バッチ書き込み戦略の明確化

現在の `event-db.ts` は **2フェーズバッチ**:
1. Regular events → 1トランザクションで一括 `put()`
2. Replaceable events → 個別トランザクションで `replaceIfNewer()`（read-then-write が必要なため）

Spec §6.1 では「`queueMicrotask()` で複数のadd()を1トランザクションにまとめる」とあるが、Replaceable event の read-then-write をどうバッチするかが未定義。

**提案:** Spec に Resonote の2フェーズ方式を明記する:
```
バッチ書き込み:
  1. Regular events → 1 IDB トランザクション (put のみ)
  2. Replaceable/Addressable → 個別トランザクション (get+compare+put)
  理由: Replaceable は既存イベントとの比較が必要であり、
        バッチ内の他イベントとの依存関係も発生しうる
```

### 2.3 [P1] `pendingDeletions` パターンの取り込み

Resonote の `comment-view-model.svelte.ts` には重要なパターンがある:

```typescript
// 削除イベントが先に到着し、対象イベントがまだ未到着のケース
private pendingDeletions = new Map<string, string>(); // eventId → deletionEventPubkey
```

kind:5 の e-tag で参照されるイベントが Store にまだ存在しない場合、Spec §5.1 ステップ4c では「検証NGの参照先は無視」となっている。

**提案:** `pendingDeletions` を Store 内部に持たせる:
```
add(kind:5 event):
  4c. eタグ参照先がStore未到着 → pendingDeletions に登録
  (後続の add() で対象イベント到着時に自動検証・削除)
```

理由: Backward REQ では kind:5 が対象イベントより先に到着することが頻繁に起きる（created_at 降順で受信するため）。

### 2.4 [P2] Negative Cache の粒度

Spec §4.6 の `fetchById` は `negativeTTL` でイベント単位のネガティブキャッシュを持つ。

Resonote の `cached-query.svelte.ts` では **フィルタ単位** のネガティブキャッシュは持たず、イベントID単位の null TTL (30秒) のみ:

```typescript
const NULL_CACHE_TTL_MS = 30_000;
fetchByIdCache.set(eventId, { event: null, cachedAt: Date.now() });
```

**提案:** フィルタ単位のネガティブキャッシュも検討する。例えば「このユーザーの kind:0 は存在しない」を 30秒キャッシュすれば、プロフィール表示時の無駄な REQ を削減できる。ただし、フィルタのハッシュ化コストとメモリ使用量のトレードオフに注意。

### 2.5 [P2] `invalidatedDuringFetch` パターンの取り込み

Resonote の `cached-query.svelte.ts` には fetch 中の削除によるキャッシュ再汚染を防ぐ仕組みがある:

```typescript
const invalidatedDuringFetch = new Set<string>();

export function invalidateFetchByIdCache(eventId: string): void {
  fetchByIdCache.delete(eventId);
  if (inflight.has(eventId)) {
    invalidatedDuringFetch.add(eventId);
  }
}
```

**提案:** `store.fetchById()` の内部実装に同等のメカニズムを組み込む。fetch 中に同じ ID の削除が `store.add(kind:5)` 経由で発生した場合、fetch 結果のキャッシュ書き込みをスキップする。

### 2.6 [P2] `seenOn` の Set 化

Spec §8 の `CachedEvent.seenOn: string[]` は配列だが、同じリレーから複数回受信した場合の重複排除が必要。

**提案:** `seenOn` を `Set<string>` にするか、`store.add()` 内で配列に追加する前に重複チェックを行う旨を明記する。

### 2.7 [P2] Svelte 5 アダプターの具体設計

Spec §12 で未解決事項とされている Svelte アダプター。Resonote の現在のパターンから逆算:

```typescript
// 現在の Resonote パターン (comment-view-model.svelte.ts)
let comments = $state<Comment[]>([]);
let deletedIds = $state<Set<string>>(new Set());

// auftakt Svelte adapter の理想形
import { createSvelteQuery } from '@ikuradon/auftakt/adapters/svelte';

const { value: comments, status } = createSvelteQuery(store, {
  kinds: [1111], '#I': ['youtube:video:abc']
});
// comments は $state<CachedEvent[]> を内部で持つ readable
// status は $state<'cached'|'fetching'|'live'|'complete'>
```

**提案:** Svelte 5 runes との統合は `$state` を内部で使う `.svelte.ts` モジュールとして実装し、返り値は plain object (getter で $state を公開) とする。`$derived` でのフィルタリングも可能にする。

### 2.8 [P1] マルチタブ時の IndexedDB 整合性

Resonote は **マルチタブ対応を一切実装していない**。`event-db.ts` のシングルトンはタブごとに独立したインスタンスを作成し、BroadcastChannel や SharedWorker は使用されていない。

**問題シナリオ:**
1. Tab A で kind:0 を受信 → IDB に保存
2. Tab B の in-memory キャッシュは更新されない → 古いプロフィールを表示し続ける
3. 両タブで Replaceable event の書き込みが競合 → `created_at` 比較なしに最後の IDB トランザクションが勝つ

**提案:** auftakt は IDB の `versionchange` イベント / BroadcastChannel で最低限のクロスタブ通知を行う:
```typescript
// Store 初期化時
const channel = new BroadcastChannel('auftakt-sync');

// add() 成功後
channel.postMessage({ type: 'event-added', eventId: event.id, kind: event.kind });

// 他タブからの通知受信
channel.onmessage = (msg) => {
  if (msg.data.type === 'event-added') {
    // 影響を受けるアクティブクエリを IDB から再取得して再 emit
  }
};
```

**MVP ではオプショナル**（各タブが独立動作でも致命的ではない）だが、v2 で対応すべき。特に Replaceable event のクロスタブ競合は、auftakt が `store.add()` で `created_at` 比較を保証するため、IDB トランザクションレベルでは正しく動くが、メモリキャッシュが不整合になる。

### 2.9 [P1] バッチクエリ対応（author チャンク・d-tag チャンク）

Resonote では **複数箇所でバッチ分割パターン** が繰り返されている:

| ファイル | バッチサイズ | 対象 |
|---------|-----------|------|
| `notifications-view-model.svelte.ts` | 100 pubkeys | follow コメント取得 |
| `wot-fetcher.ts` | 100 pubkeys | 2ホップ WoT フェッチ |
| `emoji-sets.svelte.ts` | 20 refs | addressable emoji set 取得 |
| `comment-subscription.ts` | 50 events | 削除 reconcile |

**提案:** `createSyncedQuery` にバッチ分割を内蔵する:
```typescript
const { events$ } = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [3], authors: followArray }, // 500人
  batchSize: 100,  // 内部で100人ずつに分割して REQ
  batchConcurrency: 3, // 最大3バッチ並行
});
```

理由: NIP-11 の `max_filters` / `max_subid_length` 制限により、大量の authors/d-tags を1 REQ に入れるとリレーが拒否する。現在はアプリ側で手動分割しているが、これは Store の責務として自然。

### 2.10 [P1] キャンセル / 世代カウンタ

Resonote の `emoji-sets.svelte.ts` は **世代カウンタ** でステール応答を防いでいる:

```typescript
let currentGen = 0;
async function fetchEmojiSets() {
  const gen = ++currentGen;
  // ... async fetch ...
  if (gen !== currentGen) return; // stale — discard
}
```

Spec の `createSyncedQuery` には `dispose()` があるが、**フィルタ変更時の前回クエリのキャンセル** が明示されていない。`emit()` でフィルタを変更した際、前回の backward REQ がまだ進行中だった場合の挙動は？

**提案:** `emit()` 呼び出し時に前回の backward subscription を自動 unsubscribe し、新しいフィルタで再開する旨を明記。内部的には世代カウンタ or AbortController で実装:
```
emit(newFilter):
  1. 前回の backward subscription を unsubscribe
  2. 新しい store.query(newFilter) を構築
  3. events$ に新クエリ結果を emit
  4. 新しい backward REQ を送信
  5. forward REQ のフィルタも hot-swap
```

### 2.11 [P2] IndexedDB クォータ超過時のグレースフルデグラデーション

Resonote は **全ての IDB アクセスを try-catch で囲み**、失敗時はリレーフォールバックで継続する:

```typescript
// podcast-resolver.ts 典型パターン
try {
  const db = await getEventsDB();
  const cached = await db.getByReplaceKey(pubkey, 39701, normalized);
  if (cached) return parseDTagEvent(...);
} catch {
  // DB not available — continue to relay query
}
```

Spec では IDB エラー時の挙動が未定義。

**提案:** auftakt のバックエンドインターフェースにフォールバック戦略を定義:
```typescript
const store = createEventStore({
  backend: indexedDBBackend('my-app', {
    onError: 'fallback-to-memory', // or 'throw' or 'ignore'
    quotaWarningThreshold: 0.8, // 80% 使用で warning emit
  }),
});
```

- `'fallback-to-memory'`: IDB 障害時に自動でメモリバックエンドに切り替え
- `'throw'`: エラーを伝播（アプリ側で制御）
- `'ignore'`: 書き込み失敗を無視、読み取りは空結果

### 2.12 [P2] Fire-and-forget 書き込みの明示サポート

Resonote の `eventsDB.put()` 呼び出しの **過半数が `void` prefix** で await されていない:

```typescript
void eventsDB.put(packet.event);                    // wot-fetcher.ts
eventsDB?.put(event).catch(err => log.error(...));   // comment-view-model.svelte.ts
```

`connectStore()` 内部の `store.add()` も同様に fire-and-forget で呼ばれるべき（リレーからのイベントストリームを止めてはいけない）。

**提案:** `store.add()` の戻り値を `Promise<AddResult>` とし、呼び出し側が await するかどうかを選べるようにする。`connectStore()` 内部は常に fire-and-forget:
```typescript
type AddResult = 'added' | 'replaced' | 'deleted' | 'duplicate' | 'expired' | 'ephemeral';
// connectStore 内部:
subscription = allEvents$.subscribe(packet => {
  void store.add(packet.event, { relay: packet.from });
});
```

### 2.13 [P2] `publishEvent` と Resonote の `castSigned` パターンの差異

Spec §4.5 の `publishEvent` は `signer` を受け取って署名 → 送信するが、Resonote の `castSigned` は **事前署名済みイベント** を直接送信する:

```typescript
// publish-signed.ts — 署名済みイベントをそのまま cast
export async function castSigned(event: NostrEvent): Promise<void> {
  const rxNostr = await getRxNostr();
  rxNostr.cast(event);  // id+sig が既に存在する前提
}
```

用途: NIP-B0 の podcast bookmark は **サーバー側で署名済み** のイベントをクライアントが publish する。

**提案:** `publishEvent` に署名済みイベントの直接送信モードを追加:
```typescript
// 未署名（Spec 既存）
publishEvent(rxNostr, store, eventParams, { signer, optimistic: true });

// 署名済み（追加）
publishSignedEvent(rxNostr, store, signedEvent, { optimistic: true });
```

### 2.14 [P2] Pending publishes のリトライ

Spec §4.5 は成功パス（`ok$` を返す）のみ定義しているが、Resonote は **失敗時のリトライキュー** を持つ:

- `pending-publishes.ts`: 失敗イベントを専用 IDB ストアに保存（TTL: 7日）
- アプリ起動時に `retryPendingPublishes()` で再試行

**提案:** auftakt の `publishEvent` にリトライ戦略を内蔵するか、少なくとも `onPublishFailed` コールバックを提供して、アプリ側のリトライキューとの接続点を作る:
```typescript
publishEvent(rxNostr, store, eventParams, {
  signer,
  optimistic: true,
  onFailed: (event) => pendingPublishes.add(event), // アプリ側フック
});
```

### 2.16 [P3] メモリバックエンドの kind 別バジェットのデフォルト値

Spec §6.2 のバジェット例:
```typescript
budgets: {
  0: { max: 5000 },   // プロフィール
  1: { max: 30000 },  // ノート
  7: { max: 10000 },  // リアクション
  default: { max: 5000 },
}
```

Resonote は kind:1111 (コメント)、kind:17 (コンテンツリアクション)、kind:39701 (NIP-B0) も頻繁に使用する。

**提案:** Resonote 向けのデフォルトプリセットを検討:
```typescript
budgets: {
  0: { max: 2000 },     // プロフィール
  1111: { max: 10000 }, // コメント
  7: { max: 5000 },     // リアクション
  17: { max: 2000 },    // コンテンツリアクション
  5: { max: 3000 },     // 削除イベント（再検証用）
  39701: { max: 1000 }, // NIP-B0 bookmarks
  default: { max: 2000 },
}
```

---

## 3. Spec に追加すべき機能

### 3.1 [P1] In-flight deduplication

Resonote の `cachedFetchById` は同一 eventId の並行 fetch を1つにまとめる:

```typescript
const inflight = new Map<string, Promise<FetchedEventFull | null>>();
const pending = inflight.get(eventId);
if (pending) return pending;
```

`store.fetchById()` にも同じ仕組みが必要。Spec §4.6 のフロー図にステップ 0 として追加:
```
0. In-flight チェック → 同じ ID の fetch が進行中ならその Promise を返す
```

### 3.2 [P1] `connectStore()` のフィルタ柔軟性

Spec §4.2 の `connectStore` のフィルタ:
```typescript
filter: (event) => event.kind !== 4, // 例: kind:4 DMも除外
```

Resonote では以下のイベントも除外候補:
- Extension bridge events (kind は未定義だが内部通信用)
- テスト環境でのイベント

**提案:** フィルタに `EventPacket` (relay 情報含む) を渡せるようにする:
```typescript
filter: (event, meta: { relay: string }) => {
  if (event.kind === 4) return false;
  if (meta.relay.endsWith('.test')) return false;
  return true;
}
```

### 3.3 [P2] 起動時キャッシュ復元のプログレス通知

Resonote のコメント機能は IndexedDB からの復元時に即座に UI に表示する:
```typescript
// comment-view-model.svelte.ts
const cached = await db.getByTagValues(tagValues);
comments = cached.map(toDomainComment);
// → UI に即表示、その後リレーから差分フェッチ
```

`createSyncedQuery` の `status$` は `'cached'` を emit するが、大量のイベントの復元が遅い場合のプログレス（件数）は通知されない。

**提案:** `status$` の `'cached'` ステータスにメタデータを含める:
```typescript
status$: Observable<
  | { phase: 'cached'; count: number }
  | { phase: 'fetching' }
  | { phase: 'live' }
  | { phase: 'complete' }
>
```

### 3.4 [P2] Relay hint の保持

Resonote は受信リレー情報を活用している:
- `comment-view-model.svelte.ts`: `packet.from` を `Comment.relayHint` に保持
- `events.ts`: `buildComment` / `buildReaction` の e-tag/p-tag に relay hint を埋め込み

Spec §8 の `CachedEvent.seenOn` は relay 一覧を保持するが、「最初に受信したリレー」(primary relay hint) を区別しない。

**提案:** `CachedEvent` に `primaryRelay?: string` を追加するか、`seenOn` を順序保証の配列とし、先頭が primary であることを仕様化する。

### 3.5 [P1] Mute フィルタリングの責務境界

Resonote の `notifications-view-model.svelte.ts` はイベント受信時に `isMuted()` と `isWordMuted()` をインラインで適用している:

```typescript
// notifications-view-model.svelte.ts
if (isMuted(event.pubkey) || isWordMuted(event.content)) return;
```

**問題:** Mute は kind:10000（NIP-44 暗号化含む）に基づくため、復号はアプリ層の責務。しかし、Store の `query()` 結果から muted ユーザーを除外したい需要がある。

**提案:** auftakt の `store.query()` にオプショナルな **post-filter** コールバックを用意する:
```typescript
store.query({
  kinds: [1111],
  '#I': ['youtube:video:abc'],
}, {
  postFilter: (event) => !isMuted(event.pubkey),
});
```

これにより:
- Store は Mute ロジックを知らない（NIP セマンティクスに集中）
- アプリ層が query 結果に対して任意のフィルタを適用できる
- reactive query の再 emit 時にも自動適用される

### 3.6 [P2] Cursor-based pagination (`until`)

Resonote の `profile-queries.ts` はカーソルベースのページネーションを実装している:

```typescript
req.emit(
  until
    ? { kinds: [1111], authors: [pubkey], limit: 20, until }
    : { kinds: [1111], authors: [pubkey], limit: 20 }
);
```

Spec の `createSyncedQuery` は `limit` をサポートするが、`until` によるページ送りの API が未定義。

**提案:** `createSyncedQuery` に `loadMore()` メソッドを追加:
```typescript
const synced = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [1111], authors: [pubkey], limit: 20 },
  strategy: 'backward',
});

// 次ページ読み込み
synced.loadMore();
// → 内部: 現在の最古イベントの created_at を until に設定して追加 REQ
// → events$ に追加結果がマージされる
```

### 3.7 [P2] WoT マルチホップフェッチのサポート

Resonote の `wot-fetcher.ts` は **2ホップ WoT** を実装:
1. 自分の kind:3 を取得 → direct follows
2. direct follows の kind:3 を 100人ずつバッチ取得 → WoT set

これは「クエリ結果に基づいて次のクエリを発行する」パターンであり、`createSyncedQuery` 単体では表現できない。

**提案:** Spec のスコープ外として明示するか、ヘルパーを検討:
```typescript
// Option A: スコープ外（アプリ側で createSyncedQuery を連鎖）
const myFollows = await firstResult(createSyncedQuery(rxNostr, store, {
  filter: { kinds: [3], authors: [myPubkey] },
  strategy: 'backward',
}));

const wotFollows = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [3], authors: extractFollows(myFollows) },
  strategy: 'backward',
  batchSize: 100,
});

// Option B: chainedQuery ヘルパー
const wot = createChainedQuery(rxNostr, store, [
  { filter: { kinds: [3], authors: [myPubkey] }, extract: extractFollows },
  { filter: (follows) => ({ kinds: [3], authors: follows }), batchSize: 100 },
]);
```

### 3.8 [P2] Optimistic update と rollback

Spec §4.5 の `optimistic: true` はストアに即追加するが、**リレー全拒否時のロールバック** が未定義。

Resonote は現在 optimistic update を使っていないが、UX 改善のために将来的に必要になる（コメント投稿時の即座表示など）。

**提案:** Optimistic update のライフサイクルを明確化:
```
publishEvent(optimistic: true):
  1. store.add(event, { optimistic: true }) → 即座に events$ に反映
  2. rxNostr.send(event) → ok$ を監視
  3a. 1つ以上の OK → optimistic フラグ解除（確定）
  3b. 全リレー拒否 or タイムアウト → store.remove(event.id) → events$ から除去
  4. UI 側に rollback を通知（status$ or 別 Observable）
```

### 3.9 [P1] 動的フィルタ追加（`addSubscription` パターン）

Resonote の Comments feature には **稼働中のサブスクリプションに追加フィルタをマージする** 重要なパターンがある:

```typescript
// comment-view-model.svelte.ts — addSubscription()
async function addSubscription(idValue: string): Promise<void> {
  // 1. 新しい idValue の IDB キャッシュを復元
  const [cachedUpper, cachedLower] = await Promise.all([
    restoreFromCache(eventsDB, `I:${idValue}`),
    restoreFromCache(eventsDB, `i:${idValue}`),
  ]);
  // 2. キャッシュ結果を既存 state にマージ
  // 3. 新しい backward + forward subscription を追加
  const filters = buildContentFilters(idValue);
  const sub = startMergedSubscription(refs, filters, dispatchPacket);
  subscriptions.push(sub);  // 複数の subscription handle を保持
}
```

用途: podcast の guid 解決時に、元の feed URL に加えて guid ベースのコメントも取得する。

Spec の `createSyncedQuery` は `emit()` でフィルタを **置換** するが、**追加** する API がない。

**提案:** `createSyncedQuery` に `addFilter()` メソッドを追加:
```typescript
const synced = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [1111, 7, 5], '#I': ['podcast:feed:xxx'] },
  strategy: 'dual',
});

// guid 解決後に追加フィルタをマージ
synced.addFilter({ kinds: [1111, 7, 5], '#I': ['podcast:guid:yyy'] });
// → 内部: 新フィルタの backward REQ を追加発行
// → store.query() は両フィルタの OR 結果を返す
// → events$ に統合結果を emit
```

代替案: 複数の `createSyncedQuery` を作成し、アプリ層で `events$` を merge する。ただし、Store の reactive query が重複再評価されるため効率が劣る。

### 3.10 [P1] NIP-40 期限切れイベントの定期パージ

Spec §5.1 ステップ3 で NIP-40 期限チェックを行うが、**既に Store に保存されたイベントが後から期限切れになるケース** の扱いが未定義。

Resonote は **NIP-40 を一切実装していない**。auftakt が最初の実装になる。

**提案:** 定期的な期限切れパージメカニズムを定義:
```typescript
// Option A: クエリ時に lazy filter（Spec §5.3 ステップ3 で既に含まれている）
// → 保存はされたままだが、query() 結果には含まれない ✓

// Option B: バックグラウンドパージ（IDB 容量削減）
const store = createEventStore({
  backend: indexedDBBackend('my-app'),
  expirationPurgeInterval: 60_000, // 60秒ごとに期限切れを IDB から物理削除
});
```

MVP では Option A（クエリ時除外のみ）で十分。IDB パージは v2 で検討。

### 3.11 [P1] `createAllMessageObservable()` の実用性検証

Spec §3 のアーキテクチャ図では `createAllMessageObservable()` を EOSE 追跡に使用するが、**Resonote では一度も使われたことがない**。

Resonote の EOSE 追跡:
- `createRxBackwardReq()` の `complete` callback で検知
- フォールバック: 5〜10秒のタイムアウト

**リスク:** `createAllMessageObservable()` は rx-nostr の全メッセージ（EVENT, EOSE, NOTICE, OK, AUTH 等）を流す。SyncedQuery が特定の subId の EOSE だけを抽出する必要がある。rx-nostr の内部 subId 生成との紐付けが必要で、公開 API では取得しにくい可能性がある。

**提案:** MVP では `createAllMessageObservable()` に依存せず、各 SyncedQuery が自身の backward subscription の `complete` イベントで EOSE を検知する方式を検討:
```typescript
// 現行 Resonote パターン（実績あり）
rxNostr.use(backwardReq).subscribe({
  complete: () => { status = 'live'; }, // backward 完了 → forward へ遷移
});
```

`createAllMessageObservable()` ベースの EOSE 追跡は v2 で、rx-nostr 側の API サポートを確認した上で導入する。

### 3.12 [P2] NIP-11 サブスクリプションスロット管理

Resonote は **NIP-11 の `max_subscriptions` 制限を一切考慮していない**。Comments の `addSubscription()` で無制限にサブスクリプションを追加できる。

auftakt の `createSyncedQuery` を多用すると、リレーあたりのサブスクリプション上限を超える可能性がある。

**提案:** auftakt レベルでサブスクリプションプールを管理:
```typescript
const store = createEventStore({
  // ...
  maxConcurrentSubscriptions: 10, // リレーあたりの上限
  subscriptionOverflow: 'queue',  // 'queue' | 'evict-oldest' | 'error'
});
```

MVP ではドキュメントに注意事項として記載し、v2 で自動管理を検討。rx-nostr 自体が内部でスロット管理をしている可能性もあるため、まず rx-nostr の挙動を確認すべき。

### 3.13 [P2] 遅延インポート対応

Resonote は **全ての nostr 関連依存を動的 `import()` で遅延ロード** している:

```typescript
// comment-subscription.ts — 典型パターン
const [{ merge }, rxNostrMod, { getRxNostr }] = await Promise.all([
  import('rxjs'),
  import('rx-nostr'),
  import('$shared/nostr/gateway.js'),
]);
```

これにより初期バンドルサイズを抑え、ログイン前のページ表示を高速化している。

**提案:** auftakt のエントリポイントも tree-shakeable かつ遅延ロード可能な設計にする:
```typescript
// Good: 個別エクスポートで tree-shaking 可能
import { createEventStore } from '@ikuradon/auftakt/core';
import { indexedDBBackend } from '@ikuradon/auftakt/backends/indexeddb';
import { createSyncedQuery } from '@ikuradon/auftakt/sync';

// Bad: バレルエクスポートで全モジュールがバンドルに含まれる
import { createEventStore, indexedDBBackend, createSyncedQuery } from '@ikuradon/auftakt';
```

Spec §3 のパッケージ構成は既にサブパス別になっており、正しい方向。`package.json` の `exports` フィールドでサブパスエクスポートを明示すること。

### 3.14 [P2] `destroyed` フラグによるライフサイクル安全性

Resonote の view model は `destroyed` フラグで非同期処理のステール更新を防止している:

```typescript
// comment-view-model.svelte.ts
let destroyed = false;

async function addSubscription(idValue: string): Promise<void> {
  const cached = await restoreFromCache(eventsDB, tagQuery);
  if (destroyed) return; // ← await 後のチェック
  // ... state 更新 ...
}

function destroy() {
  destroyed = true;
  for (const sub of subscriptions) sub.unsubscribe();
}
```

Spec の `createSyncedQuery` は `dispose()` で購読解除するが、**dispose 後に Store の reactive query が emit するケース** への対処が未定義。

**提案:** `dispose()` 呼び出し後の保証を明記:
```
dispose():
  1. backward/forward subscription を unsubscribe
  2. store.query() の reactive 購読を解除
  3. events$ / status$ を complete
  4. 以降の emit() 呼び出しは no-op（エラーではない）
  5. Store 側のクエリ逆引きインデックスからも除去
```

### 3.15 [P3] Tag prefix 正規化

Resonote のタグクエリは大文字・小文字の `I`/`i` タグの両方を検索する:
```typescript
// comment-subscription.ts
const tagPrefixes = ['I:', 'i:'];
```

auftakt の `store.query()` でも同様の正規化が必要か、アプリ側の責務とするかを明確化すべき。

**提案:** Store は大文字・小文字を区別して保存し、query 側でフィルタ配列を渡せるようにする（NIP-73 では `I` タグが正式だが、互換性のため `i` タグも検索したいケースがある）。

### 3.16 [P3] キャッシュ済みイベントの署名再検証

Resonote は **IndexedDB から復元したイベントの署名を再検証しない**（rx-nostr がリレー受信時に検証済みと信頼）。

auftakt も同じ前提（trusted cache）でよいが、明示的にドキュメント化すべき:

```
セキュリティモデル:
  - リレーから受信したイベントは rx-nostr の verifier で署名検証済み
  - Store に保存されたイベントは信頼される（再検証しない）
  - IndexedDB は同一オリジンポリシーで保護される
  - 外部ソースから直接 store.add() する場合、呼び出し側が検証済みであることを保証
```

---

## 4. 移行時のリスクと対策

> §4.1〜4.3 は既存の内容。以下に追加のリスクを記載。

### 4.1 IndexedDB マイグレーション

現在の `event-db.ts` のスキーマと auftakt の IDB スキーマは異なる。既存ユーザーのキャッシュデータを破棄するか、マイグレーションするかの判断が必要。

**提案:**
- **Phase 1:** auftakt 用の新しい DB 名 (`resonote-auftakt`) を使い、旧 DB (`resonote-events`) は読み取り専用で残す
- **Phase 2:** 初回起動時に旧 DB からの移行を BackgroundSync で実行
- **Phase 3:** 移行完了後に旧 DB を削除

### 4.2 Feature 固有のドメインロジック

Comments feature の `pendingDeletions`、`orphanParent` fetch、`placeholders` は **ドメイン固有** であり、auftakt の汎用ストアには含めるべきでない。

**対策:** auftakt は「イベントの保存・クエリ・NIP セマンティクス」に集中し、Feature 固有のロジックは以下のように分離:
```
auftakt (NIP セマンティクス)
  ↓ events$: CachedEvent[]
Feature layer (ドメインロジック)
  ↓ comments: Comment[]
UI layer (表示)
```

### 4.3 テスト環境

Resonote は `fake-indexeddb/auto` + `vi.mock()` + `@ikuradon/tsunagiya MockPool` でテストしている。auftakt もこの環境で動作する必要がある。

**提案:** auftakt のバックエンド抽象化により、テストではメモリバックエンドを使えるようにする。統合テストでは `fake-indexeddb` を使用。

### 4.4 `connectStore()` と既存の feature-specific サブスクリプションの共存

`connectStore()` は `createAllEventObservable()` で全イベントを Store に流し込むが、Resonote の一部 feature は **Store に保存すべきでない一時的なイベント処理** を行っている:

- `relays-config.ts`: NIP-65 のリレーリスト取得は一時的。kind:10002 を永続化する意味は薄い（ユーザーごとに1件のみ必要）
- `nip19-resolver/fetch-event.ts`: NIP-19 リンクのワンショット解決。結果は表示後に不要

**対策:** `connectStore()` のフィルタで除外するか、Store の容量バジェットに任せる。明示的に「保存しないイベントリスト」をドキュメント化すべき。

### 4.5 バンドルサイズへの影響

現在の Resonote の nostr 関連バンドル:
- `rx-nostr` + `@rx-nostr/crypto`: 既に依存
- `idb`: IndexedDB ラッパー（軽量）

auftakt 追加による増分:
- RxJS operators（既に rx-nostr 経由で依存）
- Store core + NIP rules + backends: 推定 5-15KB gzipped

**リスク:** `pnpm perf:bundle:summary` で変化を確認すべき。Resonote は既存の `event-db.ts` + `cached-query.svelte.ts` を削除するため、純増は限定的。

### 4.6 暗号化イベント (NIP-44/NIP-04) の扱い

Resonote の `mute.svelte.ts` は kind:10000 の **暗号化 content** を持つ。auftakt の Store は暗号化された content をそのまま保存するが、復号は行わない。

**注意点:**
- `store.query()` で返される `CachedEvent.event.content` は暗号化されたまま
- アプリ層で復号 → ドメインモデルに変換の責務
- Store は content の中身に基づくクエリ（全文検索等）をサポートしない → 正しい判断
- kind:10000 の `tags` は平文（public mute list）、`content` は暗号文（private mute list）の混在に注意

---

## 5. Spec が正しく解決する問題（検証済み）

| Resonote の現在の課題 | auftakt の解決策 | 検証 |
|---------------------|----------------|------|
| 8箇所の `db.put()` 散在 | `connectStore()` で一元化 | ✅ `createAllEventObservable()` が全イベントをキャッチ |
| 15箇所の subscription セットアップ | `createSyncedQuery()` | ✅ backward/forward/dual strategy で網羅 |
| `uniq()` の手動適用 | Store の重複判定 | ✅ `add()` ステップ2 の event.id チェック |
| cache-aware since 計算 | SinceTracker | ✅ `since-tracker.ts` で自動化 |
| kind:5 のクロスサブスクリプション問題 | Store レベルの `deletedIds` | ✅ 全 feature で共有される |
| Replaceable event の手動管理 | `add()` 内の自動置換 | ✅ ステップ5-6 で処理 |
| `cachedFetchById` の複雑さ | `store.fetchById()` | ✅ 3段フォールバック内蔵 |
| Notification の since 管理 | SyncedQuery | ✅ staleTime + cache-aware since |
| NIP-40 期限切れの未実装 | `add()` + `query()` で自動処理 | ✅ Spec §5.1 ステップ3 + §5.3 ステップ3 |
| `addSubscription()` のボイラープレート | SyncedQuery.addFilter() | ⚠️ Spec に API 未定義（§3.9 で提案） |
| 世代カウンタによるステール防止 | SyncedQuery 内部で自動 | ⚠️ `emit()` 時のキャンセルを明記すべき（§2.10） |
| subscription スロット超過リスク | — | ⚠️ Spec で未対応（§3.12 で提案） |

---

## 6. 優先度まとめ

### P1 (MVP に含めるべき)

**Spec 修正:**
- [ ] `replace_key` のインデックス順序統一 (§2.1)
- [ ] 2フェーズバッチ書き込みの明確化 (§2.2)
- [ ] `pendingDeletions` パターン — 削除イベント先着時の保留 (§2.3)
- [ ] マルチタブ設計方針の明確化 — MVP は独立タブ前提でもよいが明記 (§2.8)
- [ ] バッチクエリ対応 — authors/d-tags のチャンク分割 (§2.9)
- [ ] キャンセル / 世代カウンタ — `emit()` 時の前回クエリ自動キャンセル (§2.10)

**Spec 追加:**
- [ ] In-flight deduplication (§3.1)
- [ ] `connectStore()` フィルタに relay 情報 (§3.2)
- [ ] Mute フィルタリングの責務境界 — postFilter コールバック (§3.5)
- [ ] 動的フィルタ追加 `addFilter()` — `addSubscription` パターン対応 (§3.9)
- [ ] NIP-40 定期パージ方針 — MVP はクエリ時除外のみ (§3.10)
- [ ] EOSE 追跡方式の再検討 — `createAllMessageObservable()` vs `complete` callback (§3.11)
- [ ] `dispose()` 後の保証仕様 — ライフサイクル安全性 (§3.14)

### P2 (v1.1 で対応)
- [ ] フィルタ単位ネガティブキャッシュ (§2.4)
- [ ] `invalidatedDuringFetch` パターン (§2.5)
- [ ] `seenOn` の重複排除 (§2.6)
- [ ] Svelte 5 アダプター具体設計 (§2.7)
- [ ] IDB クォータ超過時のグレースフルデグラデーション (§2.11)
- [ ] Fire-and-forget 書き込みの明示サポート (§2.12)
- [ ] `publishSignedEvent` — 署名済みイベントの直接送信 (§2.13)
- [ ] Pending publishes のリトライフック (§2.14)
- [ ] 復元プログレス通知 (§3.3)
- [ ] Relay hint の保持 (§3.4)
- [ ] Cursor-based pagination (`loadMore()`) (§3.6)
- [ ] WoT マルチホップの設計方針 (§3.7)
- [ ] Optimistic update のロールバック定義 (§3.8)
- [ ] NIP-11 サブスクリプションスロット管理 (§3.12)
- [ ] 遅延インポート / サブパスエクスポート対応 (§3.13)

### P3 (将来検討)
- [ ] Kind 別バジェットのプリセット (§2.16)
- [ ] Tag prefix 正規化方針 (§3.15)
- [ ] キャッシュ済みイベントの署名再検証ポリシー (§3.16)
- [ ] BroadcastChannel によるクロスタブ同期 (§2.8 の v2)

---

## 7. Spec のスコープ外とすべきもの

以下は auftakt の責務ではなく、アプリ層が引き続き所有すべき:

| 機能 | 理由 |
|------|------|
| Mute list の復号 (NIP-44/NIP-04) | 暗号鍵はアプリ/signer の責務 |
| Pending publishes のリトライキュー | 発行失敗は一時的状態であり、永続イベントストアの関心外 |
| Extension bridge のメッセージパッシング | Nostr イベントではない |
| Relay 接続管理 / NIP-42 AUTH | rx-nostr の責務 |
| Orphan parent の placeholder 表示 | UI/feature ドメインのロジック |
| Content provider の URL 解決 | アプリ固有のビジネスロジック |
| Profile の NIP-05 検証 | 外部 HTTP リクエストが必要、Store の関心外 |

---

## 8. 結論

**auftakt は Resonote に対して高い投資効果がある。** 現在のコードベースで確認できたボイラープレート（8+ `db.put()`、15+ subscription セットアップ、4 `uniq()`、3 since 計算、4箇所のバッチ分割パターン）の大部分を解消できる。

特に以下の3点が最も価値が高い:

1. **kind:5 のクロスサブスクリプション整合性** — 現在 Comments feature 以外では削除が反映されないリスクがある。Store レベルの `deletedIds` で根本解決。

2. **バッチクエリの一元化** — notifications (100 pubkeys)、WoT (100 pubkeys)、emoji sets (20 refs)、deletion reconcile (50 events) の4箇所で手動実装されているバッチ分割を、`createSyncedQuery` の `batchSize` オプションで吸収。

3. **キャンセル / ステール防止** — `emoji-sets.svelte.ts` の世代カウンタ、`cached-query.svelte.ts` の `invalidatedDuringFetch` など、散在する防御コードを Store 内部に集約。

Spec の設計判断（Operator ではなく Event Store 方式、rx-nostr 専用）は、Resonote の実装経験から見ても正しい。§2 の設計判断の経緯に記載された3つの不採用理由（フィルタアクセス不能、クロスサブスクリプション問題、emit取り消し不能）は、すべて Resonote のコードベースで実際に遭遇している問題と一致する。

**推奨アクションプラン:**
1. P1 提案（13項目: Spec修正6 + Spec追加7）を Spec に反映
2. MVP スコープを確定（§7 のスコープ外を明確に除外）
3. EOSE 追跡方式の PoC — `createAllMessageObservable()` vs 既存の `complete` callback の比較検証
4. Resonote の `event-db.ts` + `cached-query.svelte.ts` を auftakt の最初のテストケースとして、既存の振る舞いを再現するテストスイートを先に作成
5. `connectStore()` + `createSyncedQuery()` の Comments feature への適用をパイロットとして実装（`addSubscription` → `addFilter()` の移行含む）
6. パイロット成功後、他 feature (notifications, profiles, bookmarks, emoji-sets) へ順次移行
7. `pnpm perf:bundle:summary` でバンドルサイズの増減を確認

---

## 9. 更新版 Spec レビュー (auftakt/docs/design.md)

**対象:** `@ikuradon/auftakt/docs/design.md` (2026-03-30 更新版)

レビュー指摘の反映状況と、更新版で新たに見えた課題を記載する。

### 9.1 レビュー指摘の反映状況

| 提案 | 状況 | 評価 |
|------|------|------|
| `replace_key` インデックス順序 (§2.1) | ✅ 採用 — `[kind, pubkey, _d_tag]` に修正 | 正しい |
| 2フェーズバッチ書き込み (§2.2) | ✅ 採用 — §6.1 に注記追加 | 正しい |
| `pendingDeletions` (§2.3) | ✅ 採用 — §5.1 ステップ4d に追加 | 正しい。ステップ8でのチェックも適切 |
| `emit()` キャンセル (§2.10) | ✅ 採用 — §4.4 に内部動作として明記 | 正しい |
| `dispose()` 保証 (§3.14) | ✅ 採用 — §4.4 に追加 | 正しい |
| `connectStore` フィルタに relay 情報 (§3.2) | ✅ 採用 — §4.2 に反映 | 正しい |
| In-flight dedup (§3.1) | ✅ 採用 — §4.6 ステップ0 に追加 | 正しい |
| EOSE 方式の再検討 (§3.11) | ✅ 採用 — backward complete callback に変更 | **特に良い判断。** subId紐付け問題を回避 |
| SSR 環境対応 | ✅ 採用 — §6.1 に追加 | 良い |
| `on` オプション (relay targeting) | ✅ 採用 — §4.4 に追加 | 正しい |
| `postFilter` コールバック (§3.5) | ❌ 不採用 — §12 に理由記載 | 後述（§9.2で議論） |
| `addFilter()` (§3.9) | ❌ 不採用 — §12 に理由記載 | 後述（§9.2で議論） |
| `batchSize` (§2.9) | ❌ 不採用 — §12 に理由記載 | **妥当。** rx-nostr 3.6.2 に `chunk()`/`batch()` 確認済み |
| マルチタブ BroadcastChannel (§2.8) | ❌ v2 — §12 に記載 | 妥当 |
| `invalidatedDuringFetch` (§2.5) | ❓ **未言及** | 後述（§9.3で指摘） |
| `seenOn` 重複排除 (§2.6) | ❓ **未言及** | 後述（§9.3で指摘） |
| `publishSignedEvent` (§2.13) | ❓ **未言及** | 後述（§9.3で指摘） |
| IDB クォータ処理 (§2.11) | ❓ **未言及** | 後述（§9.3で指摘） |
| Optimistic rollback (§3.8) | ❓ **未言及** | 後述（§9.3で指摘） |
| Cursor pagination (§3.6) | ❓ **未言及** | 後述（§9.3で指摘） |
| セキュリティモデル (§3.16) | ❓ **未言及** | 後述（§9.3で指摘） |

### 9.2 不採用項目への意見

#### `postFilter` の不採用 — **概ね妥当だが注意点あり**

Spec §12 の理由:
> `events$.pipe(map(...))` やSvelteの`$derived`で1行で代替可能。Storeに外部状態（muteリスト等）の変更検知を持たせると複雑化する

**同意する点:** Mute リストの変更検知を Store に持たせるのは過剰。

**注意点:** `events$.pipe(map(events => events.filter(e => !isMuted(e.pubkey))))` はミュートリスト変更時に再 emit されない。RxJS で対応するには:
```typescript
combineLatest([events$, muteList$]).pipe(
  map(([events, muted]) => events.filter(e => !muted.has(e.pubkey)))
);
```
Svelte では `$derived` で自然に対応可能。**RxJS ユーザー向けにこのパターンをドキュメントに例示すべき。**

#### `addFilter()` の不採用 — **妥当だが `combineLatest` の注意点あり**

Spec §12 の理由:
> 複数の`createSyncedQuery`を`combineLatest`でマージすれば同等

**同意する点:** SyncedQuery の内部状態管理を複雑化させるべきでない。

**注意点 1:** `combineLatest` は全ソースが最低1回 emit するまで待機する。2つ目の SyncedQuery のキャッシュが空だと、リレー応答まで結合結果が emit されない。対策:
```typescript
combineLatest([
  synced1.events$,
  synced2.events$.pipe(startWith([])),  // ← 初期値で即 emit
]);
```

**注意点 2:** 2つの SyncedQuery の `events$` を concat すると重複イベントが混入する可能性がある（フィルタが重複する場合）。アプリ層で `uniqBy(event.id)` が必要。

**注意点 3:** `status$` の統合。2つの SyncedQuery の `status$` を統合するヘルパーがあると便利:
```typescript
// 両方が 'live' なら 'live'、いずれかが 'fetching' なら 'fetching'、etc.
```

**→ ドキュメントに `combineLatest` + `startWith([])` + dedup のレシピを例示することを推奨。**

#### `batchSize` の不採用 — **妥当**

rx-nostr 3.6.2 に `chunk()` operator が存在することを確認済み。ただし **Resonote では現在使われていない**（手動ループで代替）。

**→ Resonote 移行時に `chunk()` operator への書き換えも含めること。**

### 9.3 更新版で未解決のまま残っている課題

#### 9.3.1 [P1] `store.add()` の戻り値・非同期契約

Spec §5.1 は `add()` の内部ロジックを定義しているが、**戻り値の型と同期/非同期の区別が未定義**。

これは `connectStore()` の内部実装に直接影響する:
```typescript
// connectStore 内部 — fire-and-forget で呼ぶべき
allEvents$.subscribe(packet => {
  void store.add(packet.event, { relay: packet.from }); // ← Promise? sync?
});
```

**提案:**
```typescript
// store.add() の契約
type AddResult = 'added' | 'replaced' | 'deleted' | 'duplicate' | 'expired' | 'ephemeral';

// メモリバックエンド: 同期的に返せる
add(event: NostrEvent, meta?: EventMeta): AddResult;

// IndexedDB バックエンド: 非同期が必要
add(event: NostrEvent, meta?: EventMeta): Promise<AddResult>;

// → 統一して Promise<AddResult> にする（メモリは即座に resolve）
// → connectStore は void で呼ぶ（結果を待たない）
// → publishEvent は結果を待つ（optimistic で即追加の場合でも）
```

#### 9.3.2 [P1] `invalidatedDuringFetch` の欠落

Resonote の `cached-query.svelte.ts` で実証済みのレース条件対策が、更新版 Spec にも不採用リストにも記載されていない。

**レース条件:**
1. `store.fetchById('abc')` 開始 → リレーに REQ 送信
2. 別の SyncedQuery で kind:5 を受信 → `store.add(deletionEvent)` → `deletedIds` に 'abc' 追加
3. ステップ1のリレー応答到着 → `store.add(event_abc)` → **削除済みなのにキャッシュに書き込まれる**

`pendingDeletions` はまだ Store に存在しないイベントの削除を保留するが、`fetchById` の in-flight 中に削除された場合はカバーしない。

**提案:** `store.add()` ステップ2（重複判定）の前に `deletedIds` チェックを追加:
```
add(event, meta?):
  1. Ephemeral判定 → ...
  1.5 削除済みチェック → deletedIds にevent.idがあれば保存しない、return 'deleted'
  2. 重複判定 → ...
```

これにより `fetchById` の結果が削除済みイベントを上書きすることを防げる。`invalidatedDuringFetch` Set は不要になる。

#### 9.3.3 [P2] `seenOn` の重複排除

Spec §8 の `CachedEvent.seenOn: string[]` について、`store.add()` ステップ2で「既存ならrelay metadataのみ更新」とあるが、同じリレーから複数回受信した場合の重複排除が未定義。

**提案:** ステップ2に注記追加:
```
2. 重複判定 (event.id) → 既存なら:
   a. meta.relay が seenOn に未含なら追加
   b. return 'duplicate'
```

#### 9.3.4 [P2] 署名済みイベント（pre-signed）の publish

Resonote の `castSigned()` は **サーバーで署名済み** のイベントを publish する（NIP-B0 podcast bookmark）。Spec §4.5 の `publishEvent` は `signer` を受け取る前提だが、事前署名済みイベントには不要。

**提案:** `publishEvent` のオーバーロードか別関数:
```typescript
// Option A: signer をオプショナルに
publishEvent(rxNostr, store, signedEvent, { optimistic: true });
// signedEvent が既に id + sig を持つ場合は signer 不要

// Option B: 明示的な別関数
publishSignedEvent(rxNostr, store, signedEvent, { optimistic: true });
```

#### 9.3.5 [P2] Optimistic update のロールバック

Spec §4.5 で `optimistic: true` は「Storeに即追加（リレー確認前にUI反映）」だが、**全リレーが拒否した場合のロールバック**が未定義。

選択肢:
- **A. ロールバックなし（fire-and-forget）** — シンプルだが、実際に保存されなかったイベントが UI に残る
- **B. 自動ロールバック** — `ok$` で全 OK:false なら `store.remove(event.id)` → `events$` から除去
- **C. アプリ層に委任** — `ok$` の結果に基づいてアプリ側が判断

**提案:** MVP では **A** を採用し、ドキュメントに明記。v2 で B を検討。

#### 9.3.6 [P2] IDB クォータ超過ハンドリング

Spec に IndexedDB の `QuotaExceededError` 時の挙動が未定義。

Resonote は全 IDB アクセスを try-catch で囲み、失敗時はリレーフォールバックで継続する。auftakt も同等のグレースフルデグラデーションが必要。

**提案:** `store.add()` の IDB 書き込み失敗時:
1. メモリ上の状態は更新済み（reactive query には反映される）
2. IDB 書き込みエラーはログに記録するが throw しない
3. 次回起動時にはメモリ上の状態は失われるが、リレーから再取得可能

#### 9.3.7 [P3] Cursor-based pagination

Profile queries で使われる `until` ベースのページ送りについて。Spec §4.4 の SyncedQuery にはページネーション API がない。

不採用リストにも記載がないため、意図的に除外したのか判断できない。

**所感:** SyncedQuery は「ライブストリーム」の抽象であり、ページネーションは `store.query()` に `until` パラメータを渡す形で直接対応可能:
```typescript
const page1$ = store.query({ kinds: [1111], authors: [pk], limit: 20 });
const page2$ = store.query({ kinds: [1111], authors: [pk], limit: 20, until: oldestTimestamp });
```
SyncedQuery に内蔵する必要はない。→ **ドキュメントにレシピとして記載を推奨。**

#### 9.3.8 [P3] セキュリティモデルの明文化

Store に保存されたイベントの署名を再検証しない前提（trusted cache）がドキュメント化されていない。

**提案:** §5 に追記:
```
セキュリティモデル:
  - connectStore() 経由のイベント: rx-nostr verifier で検証済み
  - store.add() 直接呼び出し: 呼び出し側が検証済みであることを保証
  - IndexedDB からの復元: trusted cache（再検証しない）
```

### 9.4 `connectStore` と `SyncedQuery` の二重処理問題

アーキテクチャ上の重要な確認点:

```
SyncedQuery が rxNostr.use(backwardReq) で REQ を発行
  → リレーからイベント到着
  → (A) connectStore の createAllEventObservable() がキャプチャ → store.add()
  → (B) SyncedQuery 自身も subscribe で受信

(A) と (B) は同じイベントを異なる経路で処理する
```

**質問:** SyncedQuery は自身のサブスクリプションで `store.add()` を呼ぶのか、`connectStore` に任せるのか？

**Spec の意図からの推測:** `connectStore` が一元的に `store.add()` を担当し、SyncedQuery は `store.query()` のリアクティブ結果を subscribe するだけ。SyncedQuery が直接 `store.add()` を呼ぶ必要はない。

**→ この責務分担を Spec §3 のアーキテクチャ図に明示すべき:**
```
SyncedQuery の役割:
  1. rxNostr.use() で REQ を管理（backward/forward/emit）
  2. store.query() の reactive 結果を events$ として公開
  3. status$ を管理（EOSE 検知含む）
  ※ store.add() は呼ばない — connectStore() が一元管理
```

**注意:** `connectStore` なしで `SyncedQuery` 単体を使うケースが存在するか？存在するなら、SyncedQuery 内部でも `store.add()` が必要になる。この前提条件を明確化すべき。

### 9.5 `dropExpiredEvents()` operator の活用

rx-nostr は NIP-40 用の `dropExpiredEvents()` operator を提供している（調査で確認済み）。

`connectStore` で以下のように使えば、期限切れイベントの Store 流入を防げる:
```typescript
allEvents$.pipe(
  dropExpiredEvents(), // rx-nostr 内蔵 operator
).subscribe(packet => {
  void store.add(packet.event, { relay: packet.from });
});
```

ただし、Store の `add()` ステップ3 でも NIP-40 チェックを行うため二重チェックになる。パフォーマンス影響は無視できるが、**どちらか一方に寄せるべき**。

**提案:** `store.add()` 側でのチェックを維持（Store 単体でも安全に使えるように）。`connectStore` での `dropExpiredEvents()` はオプション。

### 9.6 更新版の評価

**全体として良い更新。** 特に以下の判断を高く評価:

1. **EOSE 方式の変更** — `createAllMessageObservable()` から backward complete callback へ。subId 紐付けの複雑さを回避し、Resonote で実績のあるパターンを採用。
2. **不採用項目の明示** (§12) — 判断理由と代替案を記録。将来の再検討時に有用。
3. **`pendingDeletions` の追加** — ステップ4d + ステップ8 の双方向チェックは正しい設計。
4. **`dispose()` 保証の追加** — ライフサイクルの契約が明確になった。

**残課題の優先度:**

| 項目 | 優先度 | 理由 |
|------|--------|------|
| `store.add()` 戻り値・非同期契約 (§9.3.1) | **P1** | API 設計の根幹 |
| `invalidatedDuringFetch` / 削除済みチェック (§9.3.2) | **P1** | データ整合性のレース条件 |
| `connectStore` と SyncedQuery の責務境界 (§9.4) | **P1** | アーキテクチャの曖昧性 |
| `seenOn` 重複排除 (§9.3.3) | P2 | 軽微 |
| 署名済み publish (§9.3.4) | P2 | Resonote の NIP-B0 で必要 |
| Optimistic rollback (§9.3.5) | P2 | MVP は fire-and-forget で可 |
| IDB クォータ (§9.3.6) | P2 | グレースフルデグラデーション |
| Cursor pagination レシピ (§9.3.7) | P3 | ドキュメントのみ |
| セキュリティモデル (§9.3.8) | P3 | ドキュメントのみ |
| `combineLatest` レシピ (§9.2) | P2 | ドキュメントのみ |
| `dropExpiredEvents()` (§9.5) | P3 | 二重チェックの整理 |

---

## 10. 第3版 Spec レビュー (2026-03-30 再更新版)

**対象:** `@ikuradon/auftakt/docs/design.md` — §14 変更履歴3行目の更新

### 10.1 §9 指摘の反映状況

| §9 の指摘 | 状況 | 評価 |
|-----------|------|------|
| §9.3.1 `store.add()` 戻り値 `Promise<AddResult>` | ✅ 採用 — §5.1 冒頭に定義追加 | 正しい。fire-and-forget の注記も適切 |
| §9.3.2 `deletedIds` チェック (step 1.5) | ✅ 採用 — §5.1 ステップ1.5に追加 | **正しい。** `invalidatedDuringFetch` が不要になる根拠も明確 |
| §9.4 `connectStore`/`SyncedQuery` 責務境界 | ✅ 採用 — §3 に責務境界を明記 | 良い。「SyncedQuery は `store.add()` を呼ばない」が明確 |
| §9.3.3 `seenOn` 重複排除 | ✅ 採用 — §5.1 ステップ2 に「未含の場合のみ」追記 | 正しい |
| §9.3.8 セキュリティモデル | ✅ 採用 — §5.3 として新設 | 良い |
| §9.3.7 Cursor pagination | ✅ 採用 — §4.3 に `until` + `limit` の例追加 | 良い。SyncedQuery に載せず `store.query()` 直接。正しい判断 |
| §9.2 `combineLatest` レシピ | ❌ 未採用 | **後述** |
| §9.3.4 署名済み publish | ❌ 未採用・未記載 | **後述** |
| §9.3.5 Optimistic rollback | ❌ 未採用・未記載 | **後述** |
| §9.3.6 IDB クォータ | ❌ 未採用・未記載 | **後述** |
| §9.5 `dropExpiredEvents()` | ❌ 未採用・未記載 | P3、現状で問題なし |

**P1 指摘 3件は全て採用済み。** 残りは P2/P3 のみ。

### 10.2 新たに追加された設計要素の評価

#### `store.changes$` (§4.3.1) — 良い追加

```typescript
store.changes$: Observable<StoreChange>
interface StoreChange {
  event: NostrEvent;
  type: 'added' | 'replaced' | 'deleted';
  relay?: string;
}
```

**評価:** TanStack Query 等との連携ポイントとして適切。`store.query()` の reactive 結果と異なり、変更差分のみを流す。v2 のアダプター戦略で活きる。

**注意点:** `type: 'replaced'` の場合、置換前のイベントも含めるか？ Replaceable event の更新で UI が「古いイベントの除去 + 新しいイベントの追加」を表現する場合に必要になる可能性がある。MVP では不要（reactive query が再 emit するため）。

#### `staleTime` 判定基準 — 良い明確化

> このSyncedQueryが前回backward REQを完了（EOSE受信）した時刻を基準とする

**注意点:** この時刻はどこに保存されるか？
- **メモリのみ** → ページリロードで stale 扱い。正しい挙動（リロード = 最新取得）
- **IDB** → リロード後もキャッシュが fresh 扱いになりうる。オフライン復帰時の挙動が複雑化

**推奨:** MVP ではメモリのみ。ドキュメントに「ページリロードで staleTime はリセットされる」と明記すべき。

#### `pendingDeletions` TTL/上限 (§5.2) — 良い追加

> TTL（デフォルト5分）または上限（デフォルト10000件）を設け、対象イベントが到着しない場合のメモリリークを防止する

**評価:** 実用的な上限。backward REQ が 5分以内に完了しないケースは稀。10000件も十分。

#### `store.query()` Nostr フィルタフルセット (§4.3) — 良い拡張

`ids`, `since`, `until`, `limit` の例が追加され、ページネーションが自然にサポートされた。

**注意点:** `since`/`until` 付き reactive query の挙動を確認:
- `store.query({ kinds: [1], until: 1000 })` を subscribe 中に、`created_at: 500` のイベントが `store.add()` で追加された場合 → フィルタに合致するので再 emit される → 正しい
- `limit: 20` の場合、21件目が追加されると最古のイベントが押し出される → reactive query が再 emit → 正しい
- ただし、`limit` 付きの reactive query は **全イベントを再ソートして limit を適用** する必要がある → v2 の差分更新（§7.3）で最適化

### 10.3 残っている P2 課題

#### 10.3.1 `combineLatest` レシピのドキュメント化

§12 で `addFilter()` を不採用とし `combineLatest` で代替としたが、具体的なレシピが Spec にない。

Resonote の `addSubscription()` パターンをそのまま移行する開発者は、以下のパターンを知る必要がある:

```typescript
// podcast の guid 解決時に追加サブスクリプションをマージ
const synced1 = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [1111, 7, 5], '#I': ['podcast:feed:xxx'] },
  strategy: 'dual',
});

// guid 解決後
const synced2 = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [1111, 7, 5], '#I': ['podcast:guid:yyy'] },
  strategy: 'dual',
});

// マージ（注意: startWith([]) + dedup が必要）
const merged$ = combineLatest([
  synced1.events$,
  synced2.events$.pipe(startWith([])),
]).pipe(
  map(([a, b]) => {
    const seen = new Set<string>();
    return [...a, ...b].filter(e => {
      if (seen.has(e.event.id)) return false;
      seen.add(e.event.id);
      return true;
    });
  }),
);

// クリーンアップ
function dispose() {
  synced1.dispose();
  synced2.dispose();
}
```

**提案:** §10 の「After」セクションに、この `combineLatest` パターンの例を追加。

#### 10.3.2 署名済みイベント publish

Resonote の NIP-B0 podcast bookmark はサーバーで署名済みのイベントを `rxNostr.cast()` で publish する。`publishEvent()` の `signer` はオプショナルであるべき。

**最小対応:** Spec §4.5 に注記追加:
```
※ signedEvent（id + sig が既に存在するイベント）を渡す場合、
   signer は省略可能。rxNostr.cast() が自動的に既存署名を使用する。
```

#### 10.3.3 IDB クォータ超過

**最小対応:** §6.1 に注記追加:
```
IDB書き込み失敗時（QuotaExceededError等）:
  - メモリ上の状態は更新済み（reactive queryには反映）
  - IDBへの永続化は失敗するが、throw しない
  - コンソールに warning を出力
  - 次回セッションではIDB上のデータは古いまま（リレーから再取得）
```

#### 10.3.4 Optimistic update のロールバック

**最小対応:** §4.5 に注記追加:
```
optimistic: true の場合:
  - イベントは即座にStoreに追加され、events$ に反映される
  - リレーの OK/NG 結果は ok$ Observable で返される
  - MVP: 自動ロールバックは行わない（リレー拒否時もStoreに残る）
  - v2: 全リレー拒否時のオプショナル自動ロールバックを検討
```

### 10.4 `fetchById` と `connectStore` の協調

§4.6 ステップ4:
> リレーにbackward REQ（oneshot）→ 結果をStoreに保存して返却

§3 の責務境界:
> `connectStore()` — `store.add()` を一元管理

この2つは矛盾する。`fetchById` が `rxNostr.use()` で REQ を発行すると、イベントは:
- (A) `connectStore` の `createAllEventObservable()` → `store.add()` (自動)
- (B) `fetchById` の自身の subscription → `store.add()`?? + Promise 解決

**選択肢:**

| 方式 | fetchById が store.add() を呼ぶ | connectStore 前提 | 単体利用 |
|------|:---:|:---:|:---:|
| A. connectStore 依存 | ❌ | ✅ | ❌ |
| B. 自前 store.add() | ✅ (dedup で安全) | 不要 | ✅ |
| C. 条件分岐 | connectStore 有無で変える | — | ✅ |

**推奨:** **方式 B**。`fetchById` は自身で `store.add()` を呼ぶ。`connectStore` が有効な場合は二重 add になるが、ステップ2 の dedup で `'duplicate'` を返すだけ。`fetchById` は `connectStore` なしでも安全に使える。

**→ §3 の責務境界の文言を修正:**
```
- connectStore() — createAllEventObservable() 経由で全subscriptionイベントをStoreに流し込む
- createSyncedQuery() — store.add() は呼ばない（connectStore に依存）
- store.fetchById() — 自身でstore.add() を呼ぶ（connectStore の有無に依存しない）
```

### 10.5 Spec の内部整合性チェック

| チェック項目 | 結果 | 備考 |
|------------|------|------|
| §5.1 のステップ番号の連続性 | ✅ | 1 → 1.5 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 |
| §4.4 の `emit()` 内部動作とステータス遷移の整合性 | ✅ | キャンセル → 再構築 → 新 REQ → status 遷移 |
| §4.4 の `dispose()` と §7.2 のクエリ逆引きインデックスの整合性 | ✅ | dispose ステップ5 で除去 |
| §4.2 の `reconcileDeletions` と §5.1 の `pendingDeletions` | ✅ | 補完関係。reconcile は起動時一括、pending は通常運用 |
| §4.6 の in-flight dedup と §5.1 ステップ2 の重複判定 | ✅ | 異なるレイヤー。in-flight は Promise 共有、ステップ2 は Store 内 |
| §5.1 ステップ1.5 と §5.1 ステップ4d の関係 | ✅ | 1.5 は「既に削除確定」、4d は「対象未到着の保留」。相補的 |
| §8 `CachedEvent.seenOn` と §6.1 `metadata` store の整合性 | ⚠️ | IDB の metadata store に seenOn を格納するが、メモリバックエンドでは CachedEvent 自体に seenOn を持つ。バックエンド抽象化で隠蔽する必要あり |
| §9 v2 の REQ 重複排除と §3 の SyncedQuery 責務 | ✅ | SyncedQuery は REQ のライフサイクルを管理、重複排除はその上のレイヤー |

### 10.6 第3版の総合評価

**Spec は実装可能な品質に達している。**

P1 の指摘は全て反映済み。残りの課題は:
- P2: 4件（`combineLatest` レシピ、署名済み publish 注記、IDB クォータ注記、optimistic rollback 注記）— いずれも Spec への1-2行の追記で対応可能
- `fetchById` と `connectStore` の協調（§10.4）— 方式 B で1文修正
- `staleTime` の保存先（§10.2）— メモリのみとの明記

**MVP 実装を開始できる状態。** 上記の P2 注記は実装中に Spec を更新すれば十分。

**推奨次ステップ:**
1. §10.4 の `fetchById` 責務境界を Spec に反映（1文修正）
2. `staleTime` はメモリのみと Spec に明記
3. core/store.ts + core/nip-rules.ts のテストファーストで実装開始
4. メモリバックエンドを最初に実装（IDB は後）
5. Resonote の `event-db.test.ts` から移植できるテストケースを特定
