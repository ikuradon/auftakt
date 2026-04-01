# コアコンセプト

## store.add() フロー

`store.add(event, meta?)` はすべてのイベント追加の入り口です。以下の順序で NIP セマンティクスを適用します。

```
0.   構造バリデーション（型チェック + サイズ制限）→ 不正なら 'rejected'
1.   Ephemeral（kind 20000-29999）→ 保存せず 'ephemeral'
1.5  backend.isDeleted() → 'deleted'（永続化された削除レコードを確認）
2.   重複チェック → seenOn 更新、'duplicate'
3.   NIP-40 有効期限切れ → 'expired'
4.   Kind 5（削除） → e-tag / a-tag の削除処理（backend に永続記録）
5.   Replaceable → created_at 比較 → 置換 → 削除チェック
6.   Addressable → (kind, pubkey, d-tag) 比較 → 置換 → 削除 + a-tag 削除チェック
7.   Regular → そのまま保存
8.   backend.isDeleted 確認 → 到着順序の逆転に対応
9.   リアクティブクエリ通知（逆引きインデックス → マイクロバッチ → 差分更新）
```

## AddResult

`store.add()` の戻り値:

| 値 | 意味 |
|----|------|
| `'added'` | 新規保存 |
| `'replaced'` | Replaceable / Addressable の更新 |
| `'deleted'` | 削除済み（backend に永続化された削除レコードに一致） |
| `'duplicate'` | 同じ ID が既に存在 |
| `'expired'` | NIP-40 有効期限切れ |
| `'ephemeral'` | Ephemeral（保存対象外） |
| `'rejected'` | 構造バリデーション失敗またはサイズ超過 |

## イベント分類

| 種類 | Kind 範囲 | 動作 |
|------|----------|------|
| Regular | 1-9999（下記以外） | そのまま保存 |
| Replaceable | 0, 3, 10000-19999 | `(pubkey, kind)` で最新のみ保持 |
| Addressable | 30000-39999 | `(kind, pubkey, d-tag)` で最新のみ保持 |
| Ephemeral | 20000-29999 | 保存拒否 |

## 置換ルール

Replaceable / Addressable イベントの競合解決:

1. `created_at` が大きい方が勝つ
2. 同値の場合: `id` が辞書順で小さい方が勝つ（NIP-01 タイブレーカー）

## リアクティブクエリ

```typescript
const events$ = store.query({ kinds: [1], authors: [pubkey], limit: 50 });
```

`store.query()` は `Observable<CachedEvent[]>` を返します。ストアにイベントが追加・置換・削除されるたびに、該当するクエリが自動的に再発行されます。

### 最適化パイプライン

```
store.add(event)
  → 逆引きインデックス: kindIndex ∪ authorIndex ∪ wildcardSet → 候補クエリ
  → matchesFilter() → ダーティセット
  → queueMicrotask() → フラッシュ（バッチ処理）
  → 差分更新（追加のみ）またはフルバックエンドクエリ（削除/置換時）
  → BehaviorSubject.next() → UI 更新
```

## Kind 5 削除

### オンライン（サブスクリプション中）

```
kind:5 到着 → e-tag と a-tag を抽出
  → e-tag: ストア内のイベントを検索 → pubkey 一致を確認 → 削除マーク
  → a-tag: Addressable イベントを検索 → pubkey + created_at 確認 → 削除マーク
  → 対象未発見 → pendingDeletions に登録（TTL: 5分、上限: 10,000）
```

### 遅延到着

```
通常イベント到着 → pendingDeletions を確認
  → 一致 + pubkey 検証 → 即座に削除マーク
  → 不一致 → 通常保存
```

### 起動時の整合性チェック

```typescript
connectStore(rxNostr, store, { reconcileDeletions: true });
// キャッシュ済みイベント ID に対して kind:5 をリレーから取得（50件ずつチャンク）
```

## イベント検証

`store.add()` は入口で構造バリデーションを行います:

- `id`, `pubkey`, `sig`, `content`: string 型
- `kind`, `created_at`: number 型（kind は整数）
- `tags`: 配列

**署名検証は行いません。** これは呼び出し側（rx-nostr やアプリケーション）の責務です。

### サイズ制限

```typescript
const store = createEventStore({
  backend: memoryBackend(),
  maxEventSize: 65536, // JSON.stringify(event).length の上限
});
```
