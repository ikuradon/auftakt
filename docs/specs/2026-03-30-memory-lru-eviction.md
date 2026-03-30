# メモリバックエンド LRU Eviction 設計

**Date:** 2026-03-30
**Status:** Approved
**Scope:** メモリバックエンドの容量管理

---

## 目的

メモリバックエンドにLRUベースのevictionを追加し、長時間使用時のメモリ無限増加を防止する。

## 設計

### トリガー

`store.add()` で `maxEvents` を超過した時のみ。バックグラウンドクリーンアップは不要。

### アクセス定義

バックエンドの `put`/`get`/`query結果` すべてでアクセス時刻を更新する。

- `put()`: 追加直後のイベントが即座にevictionされることを防ぐ
- `get()`: fetchById等で明示的に取得したイベントを保護
- `query()`: 結果セットに含まれるイベントのアクセス時刻を更新

### kind別バジェット

各kindごとのハードリミット。超過時はそのkind内でLRU最古から削除。

**デフォルト値:**
```typescript
const DEFAULT_BUDGETS: Record<number, number> = {
  0: 5000,      // プロフィール
  1: 30000,     // ノート
  7: 10000,     // リアクション
};
const DEFAULT_BUDGET = 5000;  // 上記以外のkind
```

**上書き:**
```typescript
memoryBackend({
  maxEvents: 50000,
  eviction: {
    strategy: 'lru',
    budgets: {
      0: { max: 2000 },
      1111: { max: 10000 },
      default: { max: 3000 },
    },
  },
});
```

ユーザー指定の `budgets` はデフォルトとマージされる。`default` キーで指定されない全kindの上限を設定。

### Pin（アクティブクエリ保護）

eviction発生時にQueryManagerから全アクティブクエリの結果イベントIDを動的収集。pinnedイベントは削除対象外。

**実装:**
```
evict():
  pinnedIds = queryManager.collectActiveEventIds()
  candidates = allEvents.filter(id => !pinnedIds.has(id))
  // candidates内でLRU最古のものから削除
```

### Evictionフロー

```
store.add(event) → 全体maxEvents超過？
  → NO: 何もしない
  → YES:
    1. event.kindのバジェットを確認
    2. そのkindの件数がバジェット超過なら、kind内でLRU最古（pinned除外）を削除
    3. まだ全体maxEvents超過なら、全体でLRU最古（pinned除外）を削除
    4. 削除されたイベントのreactive queryを再評価
```

### アクセス順序のデータ構造

`Map<eventId, number>` でアクセス時刻（`Date.now()`）を記録。eviction時にソートして最古を選定。

LinkedListの方が理論上O(1)だが、evictionは低頻度（maxEvents超過時のみ）なのでMap + ソートで十分。

## API変更

`memoryBackend()` の引数を拡張:

```typescript
interface MemoryBackendOptions {
  maxEvents?: number;         // デフォルト: 制限なし（undefined）
  eviction?: {
    strategy: 'lru';
    budgets?: Record<number | 'default', { max: number }>;
  };
}
```

`maxEvents` が未指定（undefined）の場合、evictionは無効。現在の挙動と後方互換。

## QueryManager変更

`collectActiveEventIds(): Set<string>` メソッドを追加。全アクティブクエリの最新結果に含まれるイベントIDを収集して返す。
