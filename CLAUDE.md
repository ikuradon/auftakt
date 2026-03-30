# CLAUDE.md - auftakt 開発ガイド

## プロジェクト概要

rx-nostr専用のリアクティブイベントストア。Nostrクライアントのキャッシュボイラープレートを一掃する。NIPセマンティクス（Replaceable/Addressable/Deletion/Expiration）をストレージ層に内蔵。

## 技術スタック

- **ランタイム**: Node.js (ESM)
- **言語**: TypeScript (strict mode)
- **テスト**: Vitest
- **リアクティブ**: RxJS 7.x
- **パッケージ**: npm (`@ikuradon/auftakt`)
- **peer deps**: rx-nostr ^3.0.0, rxjs ^7.8.0
- **テスト用**: fake-indexeddb, @ikuradon/tsunagiya

## コマンド

```bash
pnpm test              # テスト実行
pnpm test:watch        # ウォッチモード
pnpm test:coverage     # カバレッジ付きテスト
pnpm lint              # 型チェック (tsc --noEmit)
pnpm build             # ビルド (tsc → dist/)
pnpm docs:dev          # ドキュメント開発サーバー
pnpm docs:build        # ドキュメントビルド
```

## 開発ワークフロー

**TDD必須。** テストを先に書いて失敗を確認してから実装する。

1. テストファイルを `tests/` に作成
2. `pnpm test -- tests/path/to/test.ts` で失敗を確認（RED）
3. 最小限の実装を書く（GREEN）
4. `pnpm test` で全テストパスを確認
5. `pnpm lint` で型チェック
6. コミット

## コーディング規約

- インデント: 2スペース
- シングルクォート
- `const` 優先、`var` 禁止
- `export` は各ファイルで行い、`src/index.ts` と `src/sync/index.ts` で re-export
- 型は `src/types.ts` に集約
- テストファイルは `tests/` に `*.test.ts` で配置
- `any` は最小限（rx-nostr との型接続部のみ許容）

## アーキテクチャ

```
src/
├── core/           # ストア本体、NIPルール、フィルタ、クエリ管理
├── backends/       # ストレージバックエンド（memory, indexeddb, cached）
├── sync/           # rx-nostr統合（connectStore, SyncedQuery, publish）
└── adapters/       # フレームワークアダプター（Svelte）
```

### 責務境界

- `connectStore()` → store.add() を一元管理
- `createSyncedQuery()` → store.add() は呼ばない（connectStoreに依存）
- `store.fetchById()` → 自身でstore.add()を呼ぶ（独立動作）
- `publishEvent()` → optimistic時のみstore.add()

### store.add() フロー

```
1. Ephemeral → reject
1.5 deletedIds → reject
2. Duplicate → seenOn更新
3. NIP-40期限切れ → reject
4. Kind 5 → 削除処理 + pendingDeletions
5. Replaceable → created_at比較 → 置換
6. Addressable → (kind,pubkey,d-tag)比較 → 置換
7. Regular → 保存
8. pendingDeletions確認
9. reactive query通知（逆引きインデックス → マイクロバッチ → 差分更新）
```

## テスト

- 172テスト、28テストファイル
- カバレッジ閾値: 80%（statements, branches, functions, lines）
- `fake-indexeddb/auto` — IndexedDBテスト
- `@ikuradon/tsunagiya` — リレーモック統合テスト
- REQ poolテスト間で共有 → `_resetReqPool()` をbeforeEachで呼ぶ

## 主要ファイル

| ファイル | 責務 |
|---------|------|
| `src/core/store.ts` | NostrEventStore本体（add, query, getSync, fetchById, changes$） |
| `src/core/query-manager.ts` | Reactive query管理（逆引きインデックス、差分更新、マイクロバッチ） |
| `src/core/nip-rules.ts` | イベント分類、置換比較 |
| `src/backends/memory.ts` | メモリバックエンド（LRU eviction、kind別バジェット） |
| `src/backends/indexeddb.ts` | IndexedDB（バッチ書き込み、ObjectStore分離、SSR） |
| `src/backends/cached.ts` | Read-throughキャッシュラッパー |
| `src/sync/synced-query.ts` | createSyncedQuery（REQライフサイクル、重複排除、cache-aware since） |
| `src/sync/global-feed.ts` | connectStore（グローバルフィード、フィルタ不一致警告） |

## Git

- コミットメッセージ: 英語、imperative mood
- Conventional Commits: feat, fix, refactor, docs, test, chore
- デフォルトブランチ: main
- コミット前に `pnpm lint && pnpm test` を実行

## リリース

- `v*` タグプッシュでnpm自動公開（GitHub Actions）
- mainブランチプッシュでドキュメント自動デプロイ（GitHub Pages）

## 設計ドキュメント

- `docs/design.md` — メイン設計仕様
- `docs/specs/` — 個別機能の設計スペック
- `docs/plans/` — 実装計画
