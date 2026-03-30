# Implementation Review: @ikuradon/auftakt v0.0.1

**Date:** 2026-03-30
**Status:** ビルド成功 / テスト 172/172 pass / カバレッジ 94.21%

---

## 1. Critical Bugs (リリース前に修正必須)

### 1.1 [BUG] `seenOn` 配列の直接ミューテーション

**ファイル:** `src/core/store.ts:212`

```typescript
existing.seenOn.push(meta.relay);
await backend.put(existing);
```

`backend.get()` で返された `StoredEvent` の `seenOn` を直接 push している。外部コードが `CachedEvent.seenOn` の参照を保持していた場合、知らないうちに変更される。

**修正案:**
```typescript
const updatedSeenOn = [...existing.seenOn, meta.relay];
await backend.put({ ...existing, seenOn: updatedSeenOn });
```

### 1.2 [BUG] IDB tag クエリが最初の値しか使わない

**ファイル:** `src/backends/indexeddb.ts:144-149`

```typescript
const tagName = tagKeys[0].slice(1);
const values = filter[tagKeys[0] as `#${string}`] ?? [];
if (values.length > 0) {
  const index = store.index('tag_index');
  rawResults = await idbRequest(index.getAll(`${tagName}:${values[0]}`));
```

`{ '#e': ['id1', 'id2'] }` の場合、`id1` のインデックスだけを引く。`id2` にマッチするイベントは `rawResults` に含まれず、後続の `matchesFilter()` で in-memory フィルタリングしても救えない。

**影響:** IDB バックエンドで複数タグ値クエリの結果が不完全。

**修正案:**
```typescript
// 全値を UNION で取得
const allResults: StoredEvent[] = [];
for (const v of values) {
  const partial = await idbRequest(index.getAll(`${tagName}:${v}`));
  allResults.push(...partial);
}
// dedup by event.id
const seen = new Set<string>();
rawResults = allResults.filter(s => {
  if (seen.has(s.event.id)) return false;
  seen.add(s.event.id);
  return true;
});
```

### 1.3 [BUG] QueryManager.flush() の unhandled rejection

**ファイル:** `src/core/query-manager.ts:195`

```typescript
this.queryFn(query.filter).then(results => {
  if (!this.queries.has(queryId)) return;
  const output = this.toOutput(results);
  query.cachedResults = output;
  query.subject.next(output);
});
```

`.catch()` がない。`backend.query()` がエラーを throw した場合（IDB クォータ超過、ブラウザの IDB 制限等）、unhandled promise rejection が発生する。

**修正案:**
```typescript
this.queryFn(query.filter).then(results => {
  if (!this.queries.has(queryId)) return;
  const output = this.toOutput(results);
  query.cachedResults = output;
  query.subject.next(output);
}).catch(err => {
  console.warn('[auftakt] Query refresh failed:', err);
});
```

### 1.4 [BUG] deletion-reconcile の二重 resolve

**ファイル:** `src/sync/deletion-reconcile.ts:50-60`

```typescript
complete: () => resolve(),
error: () => resolve(),
```
と
```typescript
setTimeout(() => {
  subscription.unsubscribe();
  resolve();
}, 10_000);
```

Promise の `resolve` が2回呼ばれうる（complete/error 後にタイムアウトが発火、またはその逆）。Promise は2回目の resolve を無視するが、`subscription.unsubscribe()` がタイムアウト経由で遅れて呼ばれる場合、complete 後に不要なリソースが残る。

**修正案:**
```typescript
let done = false;
const finish = () => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  subscription.unsubscribe();
  resolve();
};

const timer = setTimeout(finish, 10_000);

const subscription = rxNostr.use(rxReq, useOptions).subscribe({
  complete: finish,
  error: finish,
});
```

---

## 2. High Priority (リリース後すぐ修正)

### 2.1 `store.changes$` が complete されない

**ファイル:** `src/core/store.ts:120,349`

`changeSubject` は `Subject<StoreChange>` だが、Store に `dispose()` メソッドがないため Subject が complete されることがない。長期間使用で subscriber がリークする。

**修正案:** `EventStore` インターフェースに `dispose(): void` を追加:
```typescript
dispose(): void {
  changeSubject.complete();
  // queryManager のクリーンアップも
}
```

### 2.2 `publishEvent` の型安全性

**ファイル:** `src/sync/publish.ts:12-14`

```typescript
rxNostr: { send(params: any, options?: any): Observable<any> },
store: EventStore,
eventParams: any,
```

`eventParams` が `any` のため、型チェックが効かない。署名済みイベントと未署名パラメータの区別もない。

**修正案:**
```typescript
interface UnsignedEvent {
  kind: number;
  tags: string[][];
  content: string;
  created_at?: number;
}

type EventParams = NostrEvent | UnsignedEvent;

export function publishEvent(
  rxNostr: { send(params: EventParams, options?: SendOptions): Observable<OkPacket> },
  store: EventStore,
  eventParams: EventParams,
  options?: PublishOptions,
): Observable<OkPacket>
```

### 2.3 `store.add()` 内の kind:5 e-tag 処理が逐次

**ファイル:** `src/core/store.ts:146-157`

```typescript
for (const targetId of eTargets) {
  const existing = await backend.get(targetId);  // N回の逐次 await
```

e-tag が多い kind:5 イベント（例: 50件の削除対象）だと、50回逐次で `backend.get()` を呼ぶ。

**修正案:** `Promise.all` で並列化:
```typescript
const existingEvents = await Promise.all(
  eTargets.map(id => backend.get(id).then(e => [id, e] as const))
);
for (const [targetId, existing] of existingEvents) { ... }
```

### 2.4 `RxNostrLike` の `any` 汚染

**ファイル:** `src/sync/synced-query.ts:20-22`

```typescript
interface RxNostrLike {
  use(rxReq: any, options?: any): Observable<any>;
}
```

`any` が3箇所。rx-nostr の型定義を使うか、最低限の型を定義すべき。

**修正案:**
```typescript
interface RxReqPacket {
  filters: NostrFilter[];
}

interface RxReqLike {
  strategy: 'backward' | 'forward';
  rxReqId: string;
  getReqPacketObservable(): Observable<RxReqPacket | null>;
}

interface UseOptions {
  on?: { relays?: string[] };
}

interface RxNostrLike {
  use(rxReq: RxReqLike, options?: UseOptions): Observable<{ event: NostrEvent; from: string }>;
}
```

### 2.5 NegativeCache にサイズ上限がない

**ファイル:** `src/core/negative-cache.ts`

Map が無制限に成長する。`has()` 呼び出し時にのみ TTL 切れエントリを削除するが、`set()` 後に `has()` が呼ばれなければ永続する。

**修正案:** `set()` 時にサイズチェック:
```typescript
set(eventId: string, ttlMs: number): void {
  this.cache.set(eventId, Date.now() + ttlMs);
  if (this.cache.size > 10000) {
    // 古いエントリを削除
    const now = Date.now();
    for (const [id, expiresAt] of this.cache) {
      if (expiresAt <= now) this.cache.delete(id);
    }
  }
}
```

---

## 3. Medium Priority (v0.1.0 で対応)

### 3.1 `memory.ts` の `query()` で tag フィルタが二重チェック

`matchesFilter()` はタグを含まない（filter-matcher.ts:10-22 がタグ処理）が、memory.ts:162-173 で独自にタグマッチングを行っている。`matchesFilter()` もタグをチェックするため、二重になる。

**確認:** `filter-matcher.ts` はタグをチェックするのか？

```typescript
// filter-matcher.ts:10-22
for (const key of Object.keys(filter)) {
  if (!key.startsWith('#')) continue;
  const requiredValues = filter[key as `#${string}`];
  if (!requiredValues || requiredValues.length === 0) continue;
  const tagName = key.slice(1);
  const eventTagValues = event.tags.filter(t => t[0] === tagName).map(t => t[1]);
  if (!requiredValues.some(v => eventTagValues.includes(v))) return false;
}
```

→ **`matchesFilter()` はタグもチェックする。** memory.ts の独自タグチェックは `_tag_index` ベースのため、`indexedTags` オプションで制限されたタグのみ対象。一方 `matchesFilter()` は元の `event.tags` を直接チェック。

→ `indexedTags` が設定されていない場合、両方とも同じ結果を返すので冗長。`indexedTags` が設定されている場合、`_tag_index` にないタグは memory.ts で false を返すが `matchesFilter()` は true を返す可能性がある。

**→ これはバグの可能性。** `indexedTags: ['e']` の場合、`{ '#p': ['pk1'] }` クエリは:
- `matchesFilter()`: event.tags の `p` タグをチェック → マッチ ✓
- memory.ts 独自チェック: `_tag_index` に `p:pk1` がない → `tagMatch = false` ✗

**結果:** `indexedTags` でインデックス対象外のタグでクエリすると結果が空になる。

**修正案:** memory.ts の独自タグチェックを削除し、`matchesFilter()` に統一する。インデックスは `query()` の最適化（候補絞り込み）にのみ使用すべき。

### 3.2 `snapshot.ts` のバリデーション不足

`loadSnapshot()` で `JSON.parse()` した結果をそのまま `store.add()` に渡している。壊れた JSON やスキーマ不一致の場合、Store に不正データが入る。

**修正案:** 最低限 `event.id` と `event.kind` の存在チェック:
```typescript
if (!event.id || typeof event.kind !== 'number') continue;
```

### 3.3 `backwardReqPool` がモジュールレベルシングルトン

**ファイル:** `src/sync/synced-query.ts:32`

```typescript
const backwardReqPool = new Map<string, PoolEntry>();
```

全ての `createSyncedQuery` インスタンスが同一の pool を共有。テスト間で `_resetReqPool()` を呼ばないと状態が漏洩する。

**リスク:** 本番環境で複数の EventStore を使うケースでは、異なる Store 向けの SyncedQuery が同じ pool を共有し、refCount が不整合になりうる。

**修正案:** Store インスタンスに紐づく pool にするか、pool のキーに store の識別子を含める。

### 3.4 `processKind5` の a-tag 削除で `created_at` 比較が不正確

**ファイル:** `src/core/store.ts:168`

```typescript
if (existing && existing.event.created_at <= event.created_at) {
```

NIP-09 では、a-tag 削除は「削除イベントの `created_at` 以前に作成された全バージョン」を対象とする。しかし、`existing` は1件だけ（最新の addressable event）を取得している。より古いバージョンがバックエンドに残っている場合は問題ないが、`<=` の等号は「同時刻のイベントも削除」を意味する。NIP-09 原文では明確でないが、一般的には `<` が安全。

### 3.5 `store.add()` で kind:5 イベント自体が `deletedIds` チェックされない

**ファイル:** `src/core/store.ts:221`

kind:5 イベントは step 1.5 の `deletedIds` チェック後、step 4 で処理されるが、kind:5 自体を削除する kind:5（kind:5 の kind:5 削除）は step 4 の `eTargets` で処理される。

**問題:** kind:5 イベント A が kind:5 イベント B を e-tag で参照して削除しようとした場合、B がまだ Store にない可能性がある（pendingDeletions で保留）。B が到着して Store に追加された後、A の削除指示は適用されない。

**影響度:** 極端なエッジケース。kind:5 の kind:5 削除は実際のプロトコルではほぼ使われない。v0.1.0 で対応可能。

---

## 4. Low Priority / 改善提案

### 4.1 `filter-matcher.ts` の空配列フィルタ処理

```typescript
if (filter.ids && !filter.ids.includes(event.id)) return false;
```

`filter.ids = []` の場合、`[].includes(event.id)` は常に `false` → マッチしない。これは NIP-01 準拠（空配列 = マッチなし）だが、明示的なドキュメント化が望ましい。

### 4.2 IDB の DB_VERSION アップグレードハンドラ

**ファイル:** `src/backends/indexeddb.ts:11`

`onupgradeneeded` で `db.objectStoreNames.contains('events')` チェックはあるが、既存ストアにインデックスを追加するマイグレーション処理がない。将来インデックスを追加する場合のパスが未整備。

### 4.3 `publishEvent` の署名済みイベント対応

Spec レビューで指摘済み。`eventParams` に `id` + `sig` がある場合は `signer` 不要だが、型で区別されていない。

### 4.4 `EventStore` に `dispose()` がない

Store の破棄方法が未定義。`changeSubject` の complete、`queryManager` のクリーンアップ、`inflight` Map のクリアなどが必要。

---

## 5. テストカバレッジの穴

全体カバレッジは 94.21% と良好だが、以下の領域が不足:

| 領域 | カバレッジ | 欠落テスト |
|------|-----------|-----------|
| `store.ts` | 83.6% | `processKind5` の a-tag 削除パス、`cleanPendingDeletions` の size > 10000 パス |
| `query-manager.ts` | 97.9% (数値上) | ただし実質テストは2件。大部分はストア経由の間接テスト |
| `snapshot.ts` | 97.05% (Branch 46%) | エラーパス（localStorage full、不正 JSON）|
| `indexeddb.ts` | 93.25% | 複数タグ値クエリ、batch write 失敗パス |

### 追加すべきテスト

1. **IDB 複数タグ値クエリ:** `{ '#e': ['id1', 'id2'] }` で2件マッチするテスト（§1.2 のバグ修正後）
2. **QueryManager の full refresh パス:** replaceable event 更新 → `pendingFullRefresh` → backend query
3. **QueryManager の limit 適用:** `{ kinds: [1], limit: 5 }` で10件追加 → 5件のみ返る
4. **NegativeCache のサイズ制限テスト:** 10000件超で古いエントリが削除される（§2.5 修正後）
5. **kind:5 の a-tag 削除:** addressable event を a-tag で削除するフルフローテスト
6. **snapshot のエラーハンドリング:** 不正 JSON、localStorage QuotaExceeded
7. **`indexedTags` 設定時のクエリ挙動:** インデックス対象外タグでのクエリ（§3.1 のバグ修正後）

---

## 6. Resonote から使えるか

### 使える

- **`connectStore()` + `store.add()`** — 既存の `eventsDB.put()` 散在を置換可能
- **`store.query()`** — reactive query で comments/notifications の subscription を簡素化
- **`store.fetchById()`** — `cachedFetchById()` を置換。in-flight dedup、negative cache 内蔵
- **NIP セマンティクス** — kind:5 削除（e-tag + a-tag）、replaceable/addressable の自動管理
- **`createSyncedQuery()`** — backward/forward/dual strategy で既存パターンを網羅
- **IDB + メモリ バックエンド** — Resonote の既存スキーマとは異なるが、機能的に同等
- **`store.changes$`** — クロスサブスクリプション削除整合性を実現

### まだ使えない / 修正が必要

| Resonote パターン | auftakt の状態 | 対応 |
|------------------|---------------|------|
| IDB 複数タグ値クエリ (`'#I'` の OR) | **バグ** (§1.2) | 修正必須 |
| `indexedTags` 制限時の正確なクエリ | **バグの可能性** (§3.1) | 修正必要 |
| 署名済みイベント publish (NIP-B0) | 型が `any` で動くが不安全 | §4.3 で型改善 |
| Store の dispose / ライフサイクル管理 | 未実装 (§4.4) | 追加必要 |
| `combineLatest` で `addSubscription` 代替 | 動くが例がない | ドキュメント追加 |

---

## 7. 欲しい機能

### 7.1 [P1] `store.dispose()`

Store のライフサイクル終了時に `changeSubject.complete()`、全クエリの unregister、`inflight` Map のクリアを行うメソッド。

### 7.2 [P1] IDB マイグレーションフレームワーク

`onupgradeneeded` 内で version ごとのマイグレーション関数を呼ぶ仕組み。将来のインデックス追加に備える。

### 7.3 [P2] `store.delete(eventId)`

外部から明示的にイベントを削除する API。Resonote の UI からの削除操作（kind:5 を自分で publish した後にローカルキャッシュも即座に更新）に必要。

現在は `store.add(kind5Event)` → `processKind5` で間接的に削除されるが、UI の即時反映には直接削除が便利。

### 7.4 [P2] `store.getById(eventId)` (同期的)

`fetchById` はリレーフォールバックを含むが、ローカルのみで十分な場合がある（orphan parent の表示等）。

### 7.5 [P2] Backend error callback

IDB 書き込み失敗時に `console.warn` だけでなく、アプリ側にコールバックで通知する仕組み。

### 7.6 [P3] `store.count(filter)`

クエリ結果の件数のみを返す。UI のバッジ表示（未読コメント数等）に有用。全件取得するより軽量。

### 7.7 [P3] QueryManager の差分更新で削除イベントを処理

現在、`notifyDeletion` は常に full refresh をトリガーする。差分で「特定イベントを cachedResults から除去」すれば、IDB 再クエリを省ける。

---

## 8. 総合評価

**リリース可能な品質に近い。** ビルド成功、テスト全パス、カバレッジ 94% は良い水準。

**ブロッカー（§1）:** 4件。特に §1.2（IDB タグクエリのバグ）と §1.3（unhandled rejection）は修正必須。

**アーキテクチャ:** 設計 spec に忠実に実装されており、Store / Backend / Sync の責務分離が明確。rx-nostr との統合も `RxNostrLike` インターフェースで疎結合。

**コード品質:** 概ね良好。`any` の使用箇所（publish.ts, synced-query.ts の RxNostrLike）は型安全性の改善余地がある。エラーハンドリングが不十分な箇所がいくつかある。

**推奨リリース手順:**
1. §1 の4件を修正
2. §1.2 修正に伴うテスト追加
3. `pnpm test:coverage` で 80% 以上を維持確認
4. v0.0.1 として publish（alpha/beta タグ推奨）
5. §2 を v0.0.2 で対応
6. Resonote への統合パイロットを開始
