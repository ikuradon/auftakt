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

## dexieBackend

ブラウザ向け。[Dexie.js](https://dexie.org/) v4 経由で IndexedDB に永続化します。[strfry](https://github.com/hoytech/strfry) リレー実装に触発されたスキーマ設計を採用しています。

```typescript
import { dexieBackend } from '@ikuradon/auftakt/backends/dexie';

const backend = dexieBackend({
  dbName: 'auftakt', // デフォルト: 'auftakt'
});
```

### インデックス（strfry inspired）

| インデックス | キー | 用途 |
|-------------|------|------|
| `id` (PK) | `id` | イベント ID 検索 |
| `created_at` | `created_at` | since/until フォールバック |
| `pubkey` | `pubkey` | 著者検索 + prefix search |
| `[kind+created_at]` | compound | kind 別クエリ（複数 kind 対応） |
| `[pubkey+kind]` | compound | Replaceable イベント検索 |
| `[kind+pubkey+_d_tag]` | compound | Addressable イベント検索 |
| `*_tag_index` | multiEntry | タグクエリ |

### クエリヒューリスティック

フィルタ内容に応じて最適なインデックスを自動選択します（strfry 準拠の優先順位）:

1. `ids` → PK 直接ルックアップ
2. `#tag` → multiEntry インデックス
3. `authors` + `kinds` → 複合インデックス
4. `authors` → pubkey インデックス（prefix search 対応）
5. `kinds` → `[kind+created_at]` 範囲スキャン
6. フォールバック → `created_at` でスキャン

### 削除追跡の永続化

削除レコードは専用テーブルに永続化されます。サイズ上限なし、TTL なし。

| テーブル | 用途 |
|---------|------|
| `deleted` | Kind 5 の e-tag 削除追跡 |
| `replaceDeletion` | Kind 5 の a-tag 削除追跡（Addressable 用） |
| `negativeCache` | fetchById のネガティブキャッシュ |

### SSR 対応

`typeof indexedDB === 'undefined'` の場合、エラーをスローします。SSR 環境では memoryBackend を使用してください。

## cachedBackend

read-through キャッシュラッパー。任意のバックエンドの前段にメモリキャッシュを置きます。

```typescript
import { cachedBackend } from '@ikuradon/auftakt/backends/cached';

const backend = cachedBackend(
  dexieBackend(),
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
| SPA（永続化） | `dexieBackend()` |
| SPA（高速 + 永続化） | `cachedBackend(dexieBackend(), { maxCached: 5000 })` |
| サーバーサイド / Bot | `memoryBackend({ maxEvents: 100_000 })` |
