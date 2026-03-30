# v2/v3 最適化 設計仕様

**Date:** 2026-03-30
**Status:** Approved

---

## 1. フィルタ逆引きインデックス (v2)

### 目的

store.add()時に全クエリを再評価するのではなく、影響を受けるクエリだけを再評価する。

### 設計

QueryManagerに3つのインデックスを追加:

```
kindIndex:    Map<number, Set<QueryId>>
authorIndex:  Map<string, Set<QueryId>>
wildcardSet:  Set<QueryId>
```

**registerQuery時:** クエリのフィルタを解析してインデックスに登録。
- `filter.kinds` があれば各kindをkindIndexに登録
- `filter.authors` があれば各authorをauthorIndexに登録
- kinds/authorsどちらもなければwildcardSetに登録

**unregisterQuery時:** インデックスからも除去。

**notifyPotentialChange(event):**
```
candidates = wildcardSet
           ∪ kindIndex.get(event.kind)
           ∪ authorIndex.get(event.pubkey)
// candidatesのみmatchesFilter()で最終判定 → dirty
```

**notifyDeletion(event):** 削除もeventのkind/pubkeyで絞り込む。
```
// 現在: 全クエリdirty
// 改善: notifyPotentialChange(event)と同じ候補選定 → dirty
```

notifyDeletionのシグネチャ変更: `notifyDeletion()` → `notifyDeletion(event: StoredEvent)`

---

## 2. 差分更新 (v2)

### 目的

dirtyクエリの再評価でbackend.query()フルスキャンを回避する。

### 設計

**追加のみ差分。** 削除・置換はフルクエリ（従来通り）。

追加が圧倒的に高頻度（リレーからのイベント到着）。削除・置換は稀であり、マイクロバッチングで低頻度にまとまるためフルクエリでも問題ない。

**flush()の変更:**

```
flush(changes: StoreChange[]):
  for each dirty query:
    if changes are all 'added':
      for each added event:
        if matchesFilter(event, query.filter):
          query.results = insertSorted(query.results, event)
          if limit: query.results = query.results.slice(0, limit)
      emit(query.results)
    else:
      // 削除・置換を含む → フルクエリ
      backend.query(filter) → emit
```

**ActiveQueryに結果キャッシュを追加:**
```typescript
interface ActiveQuery {
  id: number;
  filter: NostrFilter;
  subject: BehaviorSubject<CachedEvent[]>;
  cachedResults: CachedEvent[];  // 追加: 前回の結果を保持
}
```

---

## 3. REQ重複排除 (v2)

### 目的

同一フィルタの複数SyncedQueryがrx-nostrに重複REQを送信するのを防ぐ。

### 設計

**完全一致のみ。** フィルタのsubset判定は複雑すぎるため行わない。

```typescript
// synced-query.ts 内部
const reqPool = new Map<string, {
  subscription: Subscription;
  refCount: number;
  rxReq: any;
}>();

function hashFilter(filter: NostrFilter): string {
  // キーをソートして正規化
  const normalized = Object.keys(filter)
    .sort()
    .reduce((acc, key) => {
      const val = filter[key as keyof NostrFilter];
      if (val !== undefined) {
        acc[key] = Array.isArray(val) ? [...val].sort() : val;
      }
      return acc;
    }, {} as Record<string, unknown>);
  return JSON.stringify(normalized);
}
```

**ライフサイクル:**
- createSyncedQuery: `hash = hashFilter(filter)` → poolにあればrefCount++、なければ新規REQ
- emit(newFilter): 旧hashのrefCount-- → 0なら解除。新hashで再度poolチェック
- dispose(): refCount-- → 0なら解除

**スコープ:** backward REQのみ共有。forward REQはフィルタ変更のhot-swapが必要なためSyncedQueryごとに独立。

---

## 4. メモリ読み出しキャッシュ + 遅延ハイドレーション (v2/v3統合)

### 目的

IndexedDB前段にメモリキャッシュを置き、IDBアクセスを減らす。起動時の全件読み込みも不要にする。

### 設計

**バックエンドラッパー** `cachedBackend(innerBackend, options)` として実装。

```typescript
import { cachedBackend } from '@ikuradon/auftakt/backends/cached';
import { indexedDBBackend } from '@ikuradon/auftakt/backends/indexeddb';

const backend = cachedBackend(indexedDBBackend('app'), {
  maxCached: 5000,
});
```

**内部動作:**

| 操作 | 動作 |
|------|------|
| `put(event)` | メモリ + inner backend 両方に書く (write-through) |
| `get(id)` | メモリ → ヒットなら返却。ミスなら inner backend → 結果をメモリに載せて返却 |
| `query(filter)` | inner backend に問い合わせ → 結果をメモリに載せて返却 |
| `delete(id)` | メモリ + inner backend 両方から削除 |
| `getByReplaceableKey()` | get()と同じread-throughパターン |
| `getByAddressableKey()` | get()と同じread-throughパターン |

**遅延ハイドレーション:** 特別な仕組みは不要。read-throughキャッシュの自然な結果として、アクセスされたイベントだけがメモリに溜まる。起動時の全件読み込みは行わない。

**メモリキャッシュの容量管理:** 内部でmemoryBackendのLRU evictionを再利用。`maxCached`超過時にLRU削除（メモリ上のみ。inner backendのデータは残る）。

**query()について:** 常にinner backendに問い合わせる。メモリキャッシュだけでは「このフィルタの結果が完全か」を判定できないため。get(id)の高速化が主な効果。

### ファイル構成

```
src/backends/
  ├── cached.ts     # 新規: cachedBackend()
  ├── interface.ts
  ├── memory.ts
  └── indexeddb.ts
```

### package.json exports追加

```json
"./backends/cached": {
  "types": "./dist/backends/cached.d.ts",
  "import": "./dist/backends/cached.js"
}
```

---

## 実装順序

1. **#1 フィルタ逆引きインデックス** — QueryManager改修のみ
2. **#2 差分更新** — QueryManager改修 (#1に依存)
3. **#3 REQ重複排除** — synced-query.ts改修
4. **#4 cachedBackend** — 新ファイル (#6+#7統合)

各項目は独立してテスト・コミット可能。
