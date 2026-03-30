# バックエンド

auftakt はストレージを抽象化しており、用途に応じてバックエンドを選択できます。

## memoryBackend

最もシンプル。すべてをメモリに保持します。

```typescript
import { memoryBackend } from '@ikuradon/auftakt/backends/memory';

const backend = memoryBackend();
```

### LRU Eviction

```typescript
const backend = memoryBackend({
  maxEvents: 10_000, // グローバル上限
  eviction: {
    strategy: 'lru',
    budgets: {
      1: { max: 5000 },   // kind:1 は最大 5000 件
      7: { max: 2000 },   // kind:7 は最大 2000 件
      default: { max: 1000 }, // その他
    },
  },
});
```

kind 別バジェットを超過すると、最も古いアクセス時刻のイベントから削除されます。`maxEvents` はバジェット適用後のグローバル上限です。

### ピン留め

特定のイベントを LRU eviction から保護できます:

```typescript
const mb = memoryBackend({ maxEvents: 100 });
mb.setPinnedIds(new Set(['important-event-id']));
```

### インデックス

memoryBackend は内部で kind インデックスと author インデックスを持ち、`query({ kinds: [...] })` や `query({ authors: [...] })` でフルスキャンを回避します。

## indexedDBBackend

ブラウザ向け。IndexedDB に永続化します。

```typescript
import { indexedDBBackend } from '@ikuradon/auftakt/backends/indexeddb';

const backend = indexedDBBackend({
  batchWrites: true, // queueMicrotask() でバッファリング
});
```

### インデックス

| インデックス | キー | 用途 |
|-------------|------|------|
| `pubkey_kind` | `[pubkey, kind]` | Replaceable イベント検索 |
| `replace_key` | `[kind, pubkey, _d_tag]` | Addressable イベント検索 |
| `kind_created_at` | `[kind, created_at]` | kind 別クエリ |
| `tag_index` | `_tag_index` (multiEntry) | タグクエリ |

### 追加メソッド

IndexedDB バックエンドのみ:

```typescript
await backend.markDeleted(eventId, deletionEventId);
const deleted = await backend.isDeleted(eventId);
await backend.setNegative(eventId, expiresAt);
const negative = await backend.isNegative(eventId);
```

### SSR 対応

`typeof indexedDB === 'undefined'` の場合、自動的に memoryBackend にフォールバックします。

## cachedBackend

read-through キャッシュラッパー。任意のバックエンドの前段にメモリキャッシュを置きます。

```typescript
import { cachedBackend } from '@ikuradon/auftakt/backends/cached';

const backend = cachedBackend(
  indexedDBBackend({ batchWrites: true }),
  { maxCached: 5000 },
);
```

### 動作

| 操作 | 動作 |
|------|------|
| `put()` | キャッシュ + inner の両方に書き込み |
| `get()` | キャッシュ → ミス時に inner → キャッシュに反映 |
| `query()` | 常に inner（結果をキャッシュに反映） |
| `delete()` | キャッシュ + inner の両方から削除 |

### 使い分け

| ユースケース | 推奨バックエンド |
|-------------|----------------|
| テスト | `memoryBackend()` |
| SPA（小規模） | `memoryBackend({ maxEvents: 10_000 })` |
| SPA（永続化） | `indexedDBBackend({ batchWrites: true })` |
| SPA（高速 + 永続化） | `cachedBackend(indexedDBBackend(...), { maxCached: 5000 })` |
| サーバーサイド / Bot | `memoryBackend({ maxEvents: 100_000 })` |
