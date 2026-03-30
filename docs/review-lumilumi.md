# Design Review: @ikuradon/auftakt for Lumilumi

**Date:** 2026-03-30
**Reviewer:** Claude (lumilumiコードベース分析に基づく)
**Spec:** `@ikuradon/auftakt` v2026-03-30 Draft (再レビュー反映後・第3版)
**Target Project:** [TsukemonoGit/lumilumi](https://github.com/TsukemonoGit/lumilumi)

---

## 0. Executive Summary

auftaktはlumilumiが現在抱えている**5層の重複排除**、**手動キャッシュ同期**、**ページネーションのボイラープレート**を根本的に解決できるポテンシャルがある。

第3版specでは、lumilumiレビューの**最重要課題を含むほぼ全ての提案が対応済み**:

**第2版で対応済み:**
- **SSR安全性** → §6.1でメモリバックエンドへの自動フォールバック追加 ✅
- **emit()時のin-flight REQキャンセル** → §4.4で内部動作5ステップとして明文化 ✅
- **NIP-50検索リレーターゲティング** → §4.4の`on`オプションで対応 ✅
- **複数RxNostrインスタンス** → §12にてconnectStore()複数回呼びで対応可能と判断 ✅
- **pendingDeletions** → §5.1 step 4d,8で到着順序問題に対応 ✅

**第3版で新たに対応:**
- **`store.changes$`** → §4.3.1で`Observable<StoreChange>`として追加 ✅ **（レビュー最重要提案）**
- **責務境界の明示** → §3でconnectStore/SyncedQueryの責務分離を明記 ✅
- **store.query()フルフィルタ対応** → §4.3で`ids`/`since`/`until`/ページネーション例追加 ✅
- **store.add()戻り値定義** → §5.1で`Promise<AddResult>`型を追加 ✅
- **署名検証責務** → §5.3セキュリティモデルとして明記 ✅
- **削除済みレース条件対策** → §5.1 step 1.5でdeletedIdsチェック追加 ✅
- **pendingDeletionsメモリリーク防止** → §5.2でTTL/上限追記 ✅
- **staleTime判定基準** → §4.4で最終backward完了時刻ベースと明記 ✅

**残存する懸念は限定的** — 以下では第3版に対する再評価と、わずかに残る設計上の確認事項を記す。

---

## 1. lumilumiの現状の課題とauftaktの対応関係

### 1.1 解決できる課題

| lumilumiの課題 | 現在の実装 | auftaktによる解決 |
|---|---|---|
| **5層の重複排除** (`tie` → `uniq()` → `createUniq()` → manual Set → TanStack Query) | 各層で独立に重複チェック。LRU 5000件制限で溢れると重複許容 | `store.add()` のid重複チェック一発で完結。容量制限もkind別バジェットで制御可能 |
| **Replaceable eventの不完全な処理** (`latestEachNaddr` がうまく動かずコンポーネント側でlatestList) | operators.ts:26 コメント「これできてないっぽい」 | `store.add()` 内部でReplaceableルール厳密適用（created_at比較＋同一タイムスタンプ時のID辞書順） |
| **Kind:5削除がストリームに反映されない** (手動でTanStack Queryからremoveするだけ) | `deleteEvent()` で自分の削除のみ。他者のkind:5は処理なし | `connectStore()` でグローバルフィードから全kind:5を自動処理。クロスサブスクリプション整合性 |
| **ページネーション60行のボイラープレート** (`usePaginatedReq` のglobalSeenEventIds管理) | 手動since/until管理、重複フィルタ、チャンク境界管理 | `createSyncedQuery` + `store.query({limit})` でストアが状態管理 |
| **since追跡の手動管理** (コンポーネント毎に `now() - 15min` やキャッシュ最新を計算) | NostrElements.svelte:43-61 | `since-tracker.ts` でキャッシュ最新タイムスタンプ自動追跡 |
| **localStorage metadata保存の脆弱性** (QuotaExceededError、フォローリスト限定保存) | metadataQueueで逐次保存 | IndexedDBバックエンドで5MBの壁を突破。kind別バジェットで自動管理 |

### 1.2 部分的にしか解決できない課題

| 課題 | 理由 | spec対応状況 |
|---|---|---|
| **2つのRxNostrインスタンス** (`rxNostr` + `rxNostr3`) | reactionsの`rxNostr3`(lazy-keep)をどう扱うか | §12: `connectStore()`を複数回呼ぶ形で対応可能。v2で正式対応 |
| **TanStack Query統合** | lumilumiは既にTanStack Queryに依存。二重管理になる可能性 | §12: v2で検討。MVPではストレージ層のみ利用で共存 |
| **mute/filterロジック** | `store.query()` のフィルタリングパイプラインにmute層をどう挟むか | §12: `events$.pipe(map(...))` や `$derived` で1行で代替可能として不採用 |

### 1.3 解決できない課題（アプリ層の責務）

- ChunkManagerによるUI仮想化
- 通知フィルタリング設定（フォロイーのみ/全員等）
- Zap検証ロジック
- メディアURL検出・分類

---

## 2. アーキテクチャ上の懸念

### 2.1 TanStack Queryとの共存問題（→ spec §12でv2へ延期）

**specの判断:** TanStack Queryアダプターはv2で検討。MVPではストレージ層のみ利用する形で共存可能。

**lumilumi視点での評価:** この判断は妥当。Phase 1（ストレージ層のみ）の導入パスが明確になる。

**現在のlumilumi:**
```
rx-nostr → operators → TanStack Query → Svelte derived stores → UI
```

**Phase 1（ストレージ層のみ利用）:**
```
rx-nostr → connectStore() → NostrEventStore (IndexedDB永続化)
     ↓                              ↓ (store変更通知)
  operators → TanStack Query ← queryClient.invalidateQueries()
                    ↓
            Svelte derived stores → UI
```

**Phase 1で実現可能なこと:**
- IndexedDB永続化（localStorage脱却）
- kind:5の自動クロスサブスクリプション処理
- Replaceable eventの厳密なセマンティクス管理
- `createTie()` の廃止（`CachedEvent.seenOn`で代替）

**Phase 1で必要な追加実装（アプリ側）:**
- `store` の変更通知を `queryClient.invalidateQueries()` に橋渡しする薄いアダプター
- 初回ロード時に `store.getSync()` をTanStack Queryの `queryFn` として使う

```typescript
// lumilumi側で作る薄いブリッジ
store.onChange((event, changeType) => {
  if (event.kind === 0) queryClient.invalidateQueries({ queryKey: ['metadata', event.pubkey] });
  if (event.kind === 1) queryClient.invalidateQueries({ queryKey: ['note', event.id] });
  // ...kind別のinvalidation
});
```

**✅ 解決済み（第3版 §4.3.1）:** `store.changes$: Observable<StoreChange>` が追加された。

```typescript
// spec §4.3.1
interface StoreChange {
  event: NostrEvent;
  type: 'added' | 'replaced' | 'deleted';
  relay?: string;
}
```

これにより、lumilumiのPhase 1導入に必要な**TanStack Queryとの橋渡し**が実現可能に:

```typescript
store.changes$.subscribe(change => {
  if (change.event.kind === 0) {
    queryClient.invalidateQueries({ queryKey: ['metadata', change.event.pubkey] });
  }
  if (change.type === 'deleted') {
    queryClient.removeQueries({ queryKey: ['note', change.event.id] });
  }
});
```

### 2.2 複数RxNostrインスタンス対応（→ spec §12でv2へ延期）

**specの判断:** `connectStore()` を複数回呼ぶ形で対応可能。v2で正式対応。

**lumilumi視点での評価:** 妥当。lumilumiの2インスタンス構成に対して:

```typescript
// Phase 1での対応方法
const disconnect1 = connectStore(rxNostr, store);   // メインデータ
const disconnect2 = connectStore(rxNostr3, store);  // リアクション
```

**確認事項:** `connectStore()` を2回呼んだ場合、同じイベントが両方のインスタンスから到着する可能性がある。`store.add()` の重複判定（§5.1 ステップ2）により安全に処理されるはず。ただし、`seenOn` のリレーメタデータが正しくマージされることを確認すべき（rxNostrとrxNostr3が異なるリレーセットを持つ場合）。

### 2.3 Svelte 5 Runesとの統合

specの `adapters/svelte.ts` はSvelte 5 readable store想定だが、lumilumiは**Svelte 5 runesベースの独自ストア**（`$state.raw`, `SvelteMap`, カスタムsubscriber）を多用。

**例: `globalRunes.svelte.ts`**
```typescript
function createCustomStore<T>(initialValue: T) {
  let state = $state.raw(initialValue);
  // ...custom subscriber pattern
}
```

**提案:** Svelteアダプターは `readable` だけでなく、`$state` ベースのrunes互換APIも提供すべき。

```typescript
// adapters/svelte.ts
export function useStoreQuery(store, filter) {
  let events = $state.raw<CachedEvent[]>([]);
  $effect(() => {
    const sub = store.query(filter).subscribe(v => { events = v; });
    return () => sub.unsubscribe();
  });
  return { get events() { return events; } };
}
```

---

## 3. specへの改良提案

### 3.1 ミュート層の組み込み（→ spec §12で不採用）

**specの判断:** `events$.pipe(map(events => events.filter(...)))` やSvelteの `$derived` で1行で代替可能。Storeに外部状態（muteリスト等）の変更検知を持たせると複雑化する。

**lumilumi視点での再評価:** この判断は**合理的**。lumilumiではミュートフィルタを以下のように適用できる:

```typescript
// RxJSパイプで適用
const filtered$ = store.query({ kinds: [1] }).pipe(
  map(events => events.filter(e => muteCheck(e.event, muteList) === 'null'))
);

// または Svelte 5 $derived で適用
const filtered = $derived(events.filter(e => muteCheck(e.event, muteList) === 'null'));
```

**残存する懸念:** ミュートリストが変更された場合、RxJSパイプ版では再評価がトリガーされない（`store.query()` はストアの変更でのみ再emit）。Svelte `$derived` 版ならmuteListの変更も追跡できるため、**Svelteアダプター経由での利用が前提**。RxJS版を使う場合は `combineLatest([events$, muteList$])` で結合する必要がある。

### 3.2 status$の拡張（→ spec §12で不採用）

**specの判断:** countは `events$` から導出可能。rx-nostrが内部でリトライ/バックオフを処理するため、実際のエラー状態がほぼ発生しない。

**lumilumi視点での再評価:** countの点は同意。エラーについては**部分的に同意**。

- rx-nostrのリレーレベルのエラーは確かに内部処理される
- ただし、**全リレーが応答しない場合**（ネットワーク断等）のタイムアウト状態をUIに伝える手段が必要
- 現在のlumilumiでは `completeOnTimeout()` operator でこれを処理しているが、auftaktの `createSyncedQuery` ではタイムアウト設定がない

**提案（軽量版）:** status$に `'timeout'` を追加するか、`createSyncedQuery` にタイムアウトオプションを設ける。

```typescript
createSyncedQuery(rxNostr, store, {
  filter: { kinds: [0], authors: [pubkey] },
  strategy: 'backward',
  timeout: 10_000, // 10秒でEOSE来なければ status$ → 'complete'
});
```

### 3.3 リレーメタデータのクエリ対応（MEDIUM）

lumilumiの `createTie()` は `seenOn: Set<string>` を追跡し、UIでリレー情報を表示する。auftaktの `CachedEvent.seenOn` はこれを代替するが、**クエリ時にリレーでフィルタする**ユースケースが抜けている。

```typescript
// lumilumiでは使っていないが、将来的にRelay Discoveryで有用
const events$ = store.query({
  kinds: [1],
  seenOn: ['wss://relay.damus.io'], // このリレーで確認されたイベントのみ
});
```

### 3.4 Batch Metadata Fetch パターン（→ spec §12で部分不採用）

**specの判断:** rx-nostrが既に `chunk()` / `batch()` operatorを提供。Storeの責務ではない。

**lumilumi視点での再評価:** チャンク分割自体はrx-nostrで対応できるが、**cache-first戦略**（キャッシュにある分はスキップし、ない分だけREQ送信）はストア層の責務。

**残存する提案:** `fetchById` と同様の「キャッシュ優先フェッチ」をバッチ対応にする。

```typescript
// キャッシュにある300人中250人はスキップ、50人だけREQ
const profiles = await store.fetchByFilter({
  kinds: [0],
  authors: pubkeys, // 300 pubkeys
}, {
  rxNostr,
  timeout: 5000,
  negativeTTL: 60_000,
});
// → 内部でStore内の既存データと差分を取り、不足分のみrx-nostr経由でフェッチ
// → チャンク分割はrx-nostrのchunk()に委譲
```

これは `fetchById` の汎用版であり、specの方針と矛盾しない。v2で検討する価値がある。

### 3.5 イベント保存時のコールバック（✅ spec §4.3.1 `store.changes$` で対応済み）

lumilumiの `saveEachNote()` オペレーターは、保存時にkind別の追加処理を行う:
- kind:0 → localStorage保存キューに追加
- kind:10003 → ブックマーク更新
- kind:30315 → ユーザーステータスマップ更新

**`store.changes$` で実現可能:**

```typescript
store.changes$.pipe(
  filter(c => c.type === 'added' || c.type === 'replaced')
).subscribe(change => {
  if (change.event.kind === 10003) updateBookmarks(change.event);
  if (change.event.kind === 30315) updateUserStatus(change.event);
});
```

**lumilumiのPhase 1移行で `saveEachNote()` オペレーターを `store.changes$` の購読に置き換えられる。**

### 3.6 ネガティブキャッシュのスコープ拡大（LOW）

specではfetchById専用だが、lumilumiでは「このpubkeyのkind:0は存在しない」のクエリレベルのネガティブキャッシュも有用。

```typescript
const profile = await store.fetchOne({
  kinds: [0], authors: [unknownPubkey],
}, { rxNostr, negativeTTL: 60_000 });
// → null (60秒間は再フェッチしない)
```

---

## 4. 導入戦略

### Phase 0: 評価（現在）

- [x] specレビュー（本ドキュメント）
- [ ] Resonoteの既存実装と比較し、移行の実現可能性を確認

### Phase 1: ストレージ層のみ導入

TanStack Queryを維持しつつ、auftaktをバックエンドストレージとして使う。

```
rx-nostr → connectStore() → NostrEventStore (IndexedDB)
                                    ↓ (invalidation signal)
                            TanStack Query (queryFn: store.getSync())
                                    ↓
                            Svelte stores → UI
```

**メリット:**
- 既存コードの変更が最小限
- IndexedDB永続化の恩恵を即座に得られる
- localStorage metadata保存を廃止できる
- kind:5自動処理が入る

**変更対象:**
- `stores.ts`: store初期化の追加
- `operators.ts`: `createTie()` を廃止（`CachedEvent.seenOn` で代替）
- `nostr.ts`: `setupRxnostr()` に `connectStore()` を追加
- 各`useReq`系: `queryFn` 内で `store.getSync()` を使うように変更

### Phase 2: Reactive Query移行

TanStack Queryを段階的にauftaktのreactive queryに置き換え。

**優先順: 効果の大きいものから**
1. `useReplaceableEvent` → `createSyncedQuery(strategy: 'backward')` — Replaceable eventのバグ修正
2. `usePaginatedReq` → `createSyncedQuery(strategy: 'dual')` + `store.query({limit})` — ページネーション簡素化
3. `useMainTimeline` → `createSyncedQuery(strategy: 'forward')` — メインタイムライン
4. リアクション系 → rxNostr3用のconnectStore追加

### Phase 3: TanStack Query廃止（Optional）

Svelteアダプターが十分成熟したら、TanStack Queryを完全に廃止。

**リスク:** TanStack Queryの `staleTime` / `gcTime` / `refetchInterval` の振る舞いをauftaktで再現する必要がある。

---

## 5. specの未解決事項へのlumilumi視点の回答

### Q1: タグインデックスの粒度

**lumilumiの使用状況:**
- `#e` (replies) — 高頻度
- `#p` (mentions) — 高頻度
- `#t` (hashtags) — 中頻度
- `#a` (addressable references) — 中頻度
- `#I` (external identifiers) — 低頻度
- `#d` (addressable d-tag) — Store内部で使用

**推奨:** デフォルトで `e`, `p`, `t`, `a`, `d` をインデックス。それ以外はopt-in設定。

```typescript
createEventStore({
  backend: indexedDBBackend('lumilumi', {
    indexedTags: ['e', 'p', 't', 'a', 'd'], // default
    // additionalTags: ['I', 'r'], // opt-in
  }),
});
```

### Q2: Svelteアダプターの具体的API

**lumilumiに必要なAPI:**

```typescript
// 1. Svelte 5 runes互換（新規コード向け）
const { events, status } = useSyncedQuery(rxNostr, store, {
  filter: { kinds: [1], authors },
  strategy: 'dual',
});
// events: $state.raw<CachedEvent[]>
// status: $state.raw<SyncStatus>

// 2. Readable store互換（既存コード移行用）
const events$ = store.query$({ kinds: [0], authors: [pubkey] });
// Svelte readable store (subscribe/unsubscribe)

// 3. 単発取得（非リアクティブ）
const event = await store.getOne({ kinds: [0], authors: [pubkey] });
```

### Q3: テスト戦略

**lumilumiの技術スタック考慮:**
- Vitest（既にpackage.jsonに含まれる可能性あり）
- fake-indexeddb（Node.js環境でのIndexedDBモック）
- rx-nostr の `createMockRxNostr()` があれば活用

### Q4: パッケージ公開スコープ

**lumilumi視点:** 独立リポジトリ推奨。理由:
- lumilumiはrx-nostr v3.6.2を使用。rx-nostr monorepo内だとバージョン結合が強くなる
- 他のrx-nostrユーザー（Resonote含む）も導入しやすい
- npm scopeは `@ikuradon/auftakt` で問題なし

---

## 6. 懸念事項と注意点

### 6.1 メモリ使用量（HIGH）

lumilumiはモバイルブラウザでも使われる。IndexedDBバックエンドを使う場合でも、reactive queryのために結果セットはメモリ上に保持される。

**現在のlumilumi:** tie LRU 5000件、TanStack Query gcTime 1時間
**auftaktメモリバックエンド:** maxEvents 50000

**推奨:** lumilumi向けデフォルトはmaxEvents 10000程度。モバイル判定で動的に変更。

### 6.2 起動時間への影響（MEDIUM）

IndexedDB起動時のハイドレーションが遅いと、現在のlocalStorage即時読み込みより体感が悪くなる可能性。

**specのv3にある `localStorageスナップショット` は lumilumiにとって重要。** 現在もlocalStorageからメタデータを即時復元しているため、この機能はMVPに含めることを推奨。

### 6.3 マイグレーション（LOW）

既存のlocalStorageメタデータキャッシュからIndexedDBへの移行パス。初回起動時にlocalStorageデータをImportする仕組みが必要。

```typescript
// 初回マイグレーション
const legacyMetadata = localStorage.getItem('metadata');
if (legacyMetadata) {
  const parsed = JSON.parse(legacyMetadata);
  for (const [pubkey, { data }] of Object.entries(parsed)) {
    await store.add(data.event);
  }
  localStorage.removeItem('metadata');
}
```

---

## 7. 追加の設計考慮事項

### 7.1 SvelteKit SSR環境でのIndexedDB（✅ spec §6.1で対応済み）

**specの対応:** `typeof indexedDB === 'undefined'` の場合、自動的にメモリバックエンドにフォールバック。

**lumilumi視点での評価:** 基本的な安全性は確保された。ただし**メモリバックエンドへのフォールバック**ではなく**no-opバックエンド**（何も保存しない）の方がSSRには適切。SSR時にメモリに保存しても、クライアントハイドレーション時に破棄されるため無駄。

**追加推奨:**
- Svelteアダプターのドキュメントに「`browser` ガード内でストアを初期化すること」を明記
- SSRフォールバック時のログ出力（意図しないSSR実行の検出）

### 7.2 複数タブでのIndexedDB共有（MEDIUM）

lumilumiには**クロスタブ同期の仕組みが一切ない**（SharedWorker/BroadcastChannel/storage eventなし）。IndexedDB導入により同じDBを複数タブが共有することになる。

**リスクと機会:**

| シナリオ | リスク | 対応 |
|---|---|---|
| タブAがkind:5を受信、タブBのメモリキャッシュが古い | 削除済みイベントがタブBで表示され続ける | BroadcastChannelでstore変更を通知 |
| タブAとBが同時にIDB書き込み | IndexedDBはトランザクション排他制御があるため安全 | 問題なし |
| タブAが容量上限に達しLRU削除、タブBはまだ参照中 | タブBのクエリ結果が突然縮小 | メモリ層はタブ独立、IDB層のみ共有 |

**提案:** MVPではクロスタブ同期は不要（lumilumiが現在対応していないため）。v2で `BroadcastChannel` による変更通知を追加。

```typescript
// v2: クロスタブ同期
const channel = new BroadcastChannel('auftakt-sync');
channel.onmessage = (e) => {
  if (e.data.type === 'invalidate') {
    store.invalidateQueries(e.data.affectedKinds);
  }
};
```

### 7.3 Optimistic Update（楽観的更新）のUI統合（HIGH）

lumilumiの現在のpublishフローは**3秒タイムアウトで全リレー確認を待つ**。UIは `$nowProgress` ストアでローディング表示するが、**発行イベントは確認前にUIに反映されない**。

auftaktの `publishEvent(optimistic: true)` はこれを大幅に改善できるが、lumilumiの既存UIパターンとの整合が必要。

**lumilumiの現在のパターン:**
```typescript
// nostr.ts:421-476 promisePublishSignedEvent
// 500msポーリングで最大3秒待つ
// 1つ以上のリレーがOKを返すか、全リレーが応答するまで待機
```

**auftakt導入で改善される点:**
- ストアに即追加 → UIに即反映
- リレー確認は非同期で処理
- 失敗時のロールバック（ストアから除去）

**追加で必要な設計:**
```typescript
const ok$ = publishEvent(rxNostr, store, eventParams, {
  signer: nip07Signer(),
  optimistic: true,
  onRollback: (event) => {
    // UI通知: 「投稿に失敗しました。再試行しますか？」
    showToast({ type: 'error', message: '投稿失敗', retry: () => ... });
  },
});
```

### 7.4 フォローリスト変更時のフィルタカスケード（HIGH）

lumilumiでフォロー/アンフォロー時の処理フロー:
1. kind:3をネットワークから再取得して比較
2. 新しいkind:3を発行
3. `followList` ストアを更新
4. `makeMainFilters()` で新しいフィルタを構築
5. `changeMainEmit()` でForwardReqのフィルタをhot-swap

auftaktの `createSyncedQuery` の `emit()` はフィルタ変更に対応するが、**フォローリスト変更→フィルタ再構築→emit()の一連のフローを自然に表現できるか**が問題。

**提案:** `createSyncedQuery` にリアクティブフィルタオプションを追加。

```typescript
const synced = createSyncedQuery(rxNostr, store, {
  // フィルタを関数として渡す（Svelteのreactivityと統合）
  filter: () => ({
    kinds: [1, 6],
    authors: Array.from(followList.keys()),
    since: lastSeen,
  }),
  // followListの変更を自動検知してre-emit
  deps: [followList], // Observable or Svelte store
  strategy: 'forward',
});
```

### 7.5 NIP-50検索リレーとの統合（✅ spec §4.4で対応済み）

**specの対応:** `createSyncedQuery` に `on` オプション追加。rx-nostrの `on` オプションをパススルー。

```typescript
// spec §4.4の例
const { events$, status$ } = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [0], authors: [pubkeyA] },
  strategy: 'dual',
  on: { relays: ['wss://relay.example.com'] }, // リレーターゲティング
});
```

**lumilumi視点での評価:** lumilumiのNIP-50検索に十分対応可能。

### 7.6 スレッド・リプライチェーンの再帰的取得（MEDIUM）

lumilumiはリプライスレッドを再帰的に取得する（`e`/`E`/`a`/`A`/`i`/`I` タグを追跡）。`fetchById` の単発取得だけでなく、**参照チェーンを辿る取得パターン**が必要。

**提案:** `store.fetchThread()` ヘルパーの追加。

```typescript
const thread = await store.fetchThread(rootEventId, {
  rxNostr,
  maxDepth: 10,         // 再帰上限
  includeRoot: true,    // ルートイベントも含む
  direction: 'replies', // 'replies' | 'parents' | 'both'
});
// → CachedEvent[] (ツリー構造ではなくフラット配列、ソート済み)
```

### 7.7 NIP-42 AUTHリレーの除外管理（LOW）

lumilumiはAUTH要求を送ったリレーを `authRelay` ストアで追跡し、再接続ロジックから除外する。auftaktの `connectStore()` がリレー接続に影響を与えないこと（rx-nostrに委譲していること）を明確にすべき。

**確認事項:** `connectStore()` は `createAllEventObservable()` を購読するだけで、リレー接続の管理には関与しない — これが正しいならOK。specに明記推奨。

### 7.8 Protected Event（`["-"]` タグ）の保存（LOW）

lumilumiは発行時にNIP-70の `["-"]` タグをReplaceable/Addressable以外のイベントに追加する。このタグはStore保存・クエリに影響しないが、**保存時に除去されないことを保証**すべき。

### 7.9 イベント署名の検証責務（✅ spec §5.3で対応済み）

**specの対応:** §5.3セキュリティモデルで3つのパスの検証責務を明確化:
- `connectStore()` 経由: rx-nostrのverifierで検証済み。Storeは再検証しない
- `store.add()` 直接呼び出し: 呼び出し側が検証済みであることを保証する責務を負う
- IndexedDBからの復元: trusted cache（同一オリジンポリシーで保護）

**lumilumi視点での評価:** lumilumiの使用パターン（rx-nostr経由のみ）に対して十分。Zap検証（kind:9734）はアプリ層で引き続き個別に実施。

### 7.10 Addressable Eventの空d-tagエッジケース（MEDIUM）

lumilumiの `latestEachNaddr` は空d-tagを `""` にフォールバックする:
```typescript
`${event.kind}:${event.pubkey}:${event.tags.find((t) => t[0] === "d")?.[1] ?? ""}`
```

auftaktの `store.add()` §5.1 ステップ6でも同様の処理が必要。specでは「dタグを抽出」としか書かれていないが、**d-tagが存在しない場合のフォールバック**を明示すべき。

**NIP-33仕様:** d-tagが存在しない場合は `""` として扱う。auftaktのnip-rules.tsでこの挙動を明示的にテストすべき。

### 7.11 Neighbor Feed（2次フォロー）パターン（LOW）

lumilumiはフォローのフォローの投稿を表示する「Neighbor Feed」機能を持つ。これは**2段階のフィルタ構築**が必要:
1. フォローリストのkind:3を取得
2. そのフォロー先のフォロー先一覧を構築
3. その一覧でkind:1をフェッチ

auftaktの`createSyncedQuery`は1段階のフィルタしかサポートしない。2段階の依存フェッチは**アプリケーション層で組み立て、結果をSyncedQueryに渡す**形になる。これは現在と同様だが、auftaktのAPIで自然に表現できるか確認が必要。

### 7.12 IndexedDBクォータ超過時のフォールバック（MEDIUM）

localStorageの `QuotaExceededError` は現在ログ出力のみで無視されている。IndexedDBでも同様のクォータ制限がある（ブラウザにより異なるが、通常50MB〜数百MB）。

**提案:** バックエンドにクォータ監視とフォールバック戦略を追加。

```typescript
const backend = indexedDBBackend('lumilumi', {
  onQuotaExceeded: (usage) => {
    // 戦略1: 古いRegularイベントから削除
    // 戦略2: メモリバックエンドにフォールバック
    // 戦略3: ユーザーに通知
    console.warn(`IndexedDB quota: ${usage.used}/${usage.quota}`);
    return 'evict-oldest'; // or 'fallback-memory' or 'throw'
  },
});
```

### 7.13 グローバルシングルトンForwardReq vs SyncedQueryライフサイクル（CRITICAL）

lumilumiの最も特徴的なアーキテクチャ: **ForwardReqはモジュールレベルのシングルトンであり、ページナビゲーションを跨いで永続する。**

```typescript
// nostr.ts:256 — モジュールスコープ、アプリ全体で1つ
const req = createRxForwardReq();

// reactions.ts:14 — 同様にグローバル
const req3 = createRxForwardReq();
```

これらは `+layout.svelte` で初期化され、ページ遷移（`/` → `/[npub]` → `/[note]`）を跨いで生き続ける。フィルタだけが `req.emit(newFilters)` で差し替えられる。

**auftaktの `createSyncedQuery` との不整合:**
- specの `createSyncedQuery` は個別のsubscription単位。コンポーネントの `dispose()` で購読解除する設計
- lumilumiのパターンは「永続的なForwardReq + フィルタhot-swap」。dispose不要

**3つの移行パターン:**

```typescript
// パターンA: グローバルSyncedQuery（lumilumiの現行パターンに最も近い）
// アプリ起動時に1回作成、disposeしない
const globalTimeline = createSyncedQuery(rxNostr, store, {
  filter: initialFilters,
  strategy: 'forward',
  persistent: true, // disposeされてもbackgroundで購読継続
});
// フォローリスト変更時
globalTimeline.emit(makeMainFilters(newContacts, since));

// パターンB: connectStore + クエリのみ（ForwardReqを残す）
// 既存のForwardReqはそのまま、connectStore経由でStoreに流し込む
connectStore(rxNostr, store); // ForwardReqの結果も含む全イベント
const events = store.query({ kinds: [1], authors: followList }); // Storeから読むだけ

// パターンC: ページ単位SyncedQuery（auftaktの想定パターン）
// ただしlumilumiでは不適切 — ページ遷移の度にforward subscriptionが切れる
```

**推奨:** lumilumiには**パターンB**が最も自然。`connectStore()` でグローバルフィードをStoreに流し込み、UIは `store.query()` で読む。既存のForwardReq管理コードをそのまま活用できる。

**第3版の責務境界明示（§3）により、パターンBの妥当性が強化された:**
> `createSyncedQuery()` — REQのライフサイクル管理 + `store.query()`のreactive結果を公開。**`store.add()` は呼ばない**
> 前提: `connectStore()` が先に呼ばれていること

つまり、lumilumiが既存のグローバルForwardReqを維持しつつ `connectStore()` で全イベントをStoreに流し込み、UIは `store.query()` で読むパターンは、specの設計意図と完全に整合する。

**新たな確認事項:** `connectStore()` の `filter` オプションでイベントを除外した場合、そのkindに対する `store.query()` や `createSyncedQuery()` は空になる。例えば `filter: (e) => e.kind !== 4` で kind:4 を除外すると、kind:4 のSyncedQueryがREQを送信しても結果がStoreに入らない。lumilumiではDMを除外する可能性があるため、この挙動をドキュメント化すべき。

### 7.14 PWA Service Workerとの相互作用（MEDIUM）

lumilumiはWorkboxベースのService Workerを持ち、以下のキャッシュ戦略を運用:
- `avatar-cache`: 7日間、最大100エントリ（アバター画像）
- `media-cache`: 共有メディアファイル
- プリキャッシュ: ビルド時のアセット

**IndexedDB導入時の考慮:**
- Service WorkerからIndexedDBにアクセスすることは技術的に可能
- しかし、Service WorkerはDOMがないためrx-nostrは動作しない
- **提案:** Service Workerはアセットキャッシュに専念し、イベントキャッシュはメインスレッドのauftaktに任せる。両者の責務を明確に分離。

**将来的な機会:** Background Sync APIと組み合わせて、オフライン時の投稿キューをService Workerで管理する可能性はある。ただしauftaktのスコープ外（spec §1「Pending publishは解決しない」）。

### 7.15 メインタイムラインのメモリリーク（HIGH）

**発見:** lumilumiのメインタイムラインは `gcTime: Infinity`, `staleTime: Infinity` で設定されている（`useMainTimelineReq` 内）。これは**TanStack Queryのガベージコレクションが一切動作しない**ことを意味し、セッション中にイベントが無限に蓄積する。

```typescript
// 現在の問題: メインタイムラインのキャッシュは決してGCされない
// 長時間セッション（モバイルでバックグラウンド放置等）でメモリ圧迫
```

**auftaktが解決できる理由:**
- kind別バジェットによるLRU管理（spec §6.2）
- アクティブクエリ結果のpin + 古いイベントの自動eviction
- メモリバックエンドの `maxEvents` 上限

**これはauftaktの強力なセールスポイント。** TanStack Queryでは実現困難な「NIPセマンティクスを考慮したLRU管理」をauftaktが提供する。

### 7.16 ビューポートベースのリアクティブサブスクリプション（MEDIUM）

lumilumiの巧妙なパターン: **画面に表示されているイベントのみリアクション購読する。**

```typescript
// SetRepoReactions (layout.svelte内):
// 1. IntersectionObserverでビューポート内のeventIdを収集
// 2. viewEventIds storeに追加
// 3. debounce(1000ms)でフィルタを更新
// 4. rxNostr3にkind:[7,6,16,9735] + "#e":viewEventIds を送信
```

このパターンは帯域を大幅に節約する。auftaktにこの概念がない。

**提案:** `createSyncedQuery` にビューポート連動モードを追加するか、**少なくともこのパターンがauftaktと自然に共存できることを検証**。

```typescript
// auftakt導入後もこのパターンは有効:
// 1. connectStore()で全リアクションをStoreに流し込む
// 2. UIはstore.query({ kinds: [7], "#e": [visibleEventId] })で読む
// 3. REQ管理は既存のviewEventIds + debounceパターンを維持

// 問題: connectStore()は全イベントをStoreに流すが、
// リアクションのREQ自体がビューポートベースなので、
// Store側で全リアクションを持つわけではない → 問題なし
```

### 7.17 バンドルサイズとTree-shaking（MEDIUM）

lumilumiの依存関係は既に大きい（rx-nostr, nostr-tools, TanStack Query, melt-ui, leaflet, markdown-it等）。明示的なバンドル最適化設定はなく、SvelteKit/Viteのデフォルトに依存。

**auftaktに求められる要件:**
- **完全にTree-shakeable** — 未使用のバックエンド・アダプター・ヘルパーがバンドルに入らないこと
- **コアのサイズ目標:** gzip後5KB以下が理想（IndexedDBバックエンド込みで10KB以下）
- **RxJS依存:** lumilumiは既にrx-nostr経由でRxJSを持っているのでここは追加負荷なし

```typescript
// 良い: 個別エントリポイント
import { createEventStore } from '@ikuradon/auftakt/core';
import { indexedDBBackend } from '@ikuradon/auftakt/backends/indexeddb';
import { createSyncedQuery } from '@ikuradon/auftakt/sync';
// → 使わないモジュール（memoryBackend, svelteAdapter等）はバンドルに含まれない

// 悪い: 単一エントリポイント
import { createEventStore, indexedDBBackend, memoryBackend, ... } from '@ikuradon/auftakt';
```

specのパッケージ構成（§3）は既にパス別エクスポートになっており良い設計。`package.json` の `exports` フィールドで個別エントリポイントを定義すること。

### 7.18 代替アプローチとの比較（WHY auftakt?）

lumilumiの視点から「なぜauftaktなのか」「他の選択肢ではなぜダメなのか」を明確にする。

| 選択肢 | 評価 | lumilumiにとっての問題 |
|---|---|---|
| **現状維持（TanStack Query + localStorage）** | ✗ | 5層重複排除、Replaceableバグ、Kind:5非伝搬、メインタイムラインのGC無しメモリリーク |
| **TanStack Queryの設定改善のみ** | △ | gcTime/staleTimeの調整では**NIPセマンティクス**（Replaceable上書き、Kind:5クロスサブスクリプション削除）を解決できない。これらはキャッシュ層ではなく**データモデル層**の問題 |
| **NDK (Nostr Dev Kit)** | ✗ | rx-nostrと完全に別のライブラリ。全面書き換えが必要。lumilumiではNDKを一切使っていない |
| **nostr-tools SimplePool** | ✗ | rx-nostrのリアクティブモデルを失う。RxJSベースの既存operatorが全て使えなくなる |
| **自前でIndexedDBキャッシュ層を構築** | △ | Resonoteが既に実施中で得られた知見がauftaktに集約されている。車輪の再発明になる |
| **@ikuradon/auftakt** | ○ | rx-nostr専用設計、NIPセマンティクス内蔵、段階的導入可能。唯一の「rx-nostrネイティブ」なソリューション |

**auftaktの本質的な価値:** TanStack Queryは「任意のデータのキャッシュ＋再フェッチ管理」であり、Nostrの**Replaceable/Addressable/Deletion/Ephemeral**というイベント種別ごとのセマンティクスを知らない。auftaktは**Nostrプロトコルの状態管理ルールをストレージ層に内蔵**することで、各featureが個別に実装していたロジックを一箇所に集約する。

### 7.19 NIP-40 期限切れイベントのストレージクリーンアップ（LOW）

lumilumiは現在NIP-40（イベント有効期限）を直接処理していない（Pollのexpiration UIは別概念）。しかし、リレーからNIP-40付きイベントが到着する可能性がある。

specの `store.add()` ステップ3で期限切れイベントの保存を拒否し、`store.query()` でも期限切れを除外するが、**保存時に有効だったイベントが後から期限切れになるケース**の扱いが未定義。

**提案:** 定期クリーンアップジョブまたはクエリ時のlazy cleanup。

```typescript
// 案A: 定期クリーンアップ（バックグラウンド）
store.startExpirationCleanup({ interval: 60_000 }); // 1分ごとに期限切れチェック

// 案B: クエリ時のlazy cleanup（spec §5.3 ステップ3で実施済み）
// クエリ結果から除外するだけで、ストレージからは削除しない
// → IDBが肥大化するリスクがあるが、シンプル

// 案C: LRU eviction時に期限切れを優先削除
// → 自然にクリーンアップされる。追加コスト最小
```

**lumilumiには案Cが最適。** LRU eviction時に期限切れイベントを優先的に削除対象にすれば、追加のタイマーやジョブなしでクリーンアップできる。

### 7.20 フィルタ変更中のin-flight REQ競合（✅ spec §4.4で対応済み）

**specの対応:** `emit()` の内部動作が5ステップで明文化:
1. 進行中のbackward subscriptionがあればunsubscribe
2. `store.query(newFilter)` で新しいreactive queryを構築
3. `events$` に新クエリのキャッシュ結果をemit
4. 新しいbackward REQを送信（strategyに応じて）
5. forward REQのフィルタもhot-swap

また `dispose()` のライフサイクル保証も明記（以降のemit()はno-op）。

**lumilumi視点での評価:** 十分。filter Aの途中結果はconnectStore経由でStoreに保存済みのため、データロスなし。

### 7.21 ストレージサイズの見積もり（LOW）

lumilumiの典型的な使用パターンからIndexedDBの必要容量を見積もる。

**仮定:**
- フォロー300人、1時間あたり平均100件の新規kind:1
- kind:0 metadata: 平均2KB/件 × 300人 = 600KB
- kind:1 notes: 平均1KB/件 × 5000件(1日分) = 5MB
- kind:7 reactions: 平均200B/件 × 10000件 = 2MB
- kind:3 contacts: 平均5KB/件 × 1人 = 5KB
- kind:5 deletions: 平均200B/件 × 500件 = 100KB
- タグインデックス: イベント数 × 平均3タグ × 50B = 2.3MB
- メタデータ（seenOn等）: イベント数 × 50B = 750KB

**1日分の概算: ~11MB**
**1週間: ~70MB**（重複排除・LRU削除前）

**推奨:** maxEvents 10000〜20000でIndexedDB使用量を20〜40MB程度に抑える。モバイルでは10000件、デスクトップでは20000件を初期設定に。

---

## 8. specへの提案まとめ（更新版spec反映後）

### 8.1 対応済み

| 提案 | spec対応 | 評価 |
|------|---------|:----:|
| **`store.changes$` 変更通知** | §4.3.1: `Observable<StoreChange>` 追加 | ✅ **最重要提案が完全対応** |
| **責務境界の明示** | §3: connectStore/SyncedQueryの役割分離 | ✅ lumilumiのパターンBと完全整合 |
| **store.query()フルフィルタ** | §4.3: ids/since/until/ページネーション例 | ✅ lumilumiの全クエリパターンをカバー |
| **store.add()戻り値** | §5.1: `Promise<AddResult>` 定義 | ✅ publishEventの楽観的更新に有用 |
| **署名検証責務** | §5.3: セキュリティモデル明記 | ✅ 3パスの責務が明確 |
| **削除済みレース条件** | §5.1 step 1.5: deletedIdsチェック | ✅ fetchById中のkind:5到着に対応 |
| **pendingDeletionsメモリリーク** | §5.2: TTL(5分)/上限(10000件) | ✅ 実用的な値 |
| **staleTime判定基準** | §4.4: 最終backward完了時刻ベース | ✅ 明確 |
| SSR環境でのIndexedDB | §6.1: メモリバックエンドへの自動フォールバック | ✅ 十分 |
| NIP-50検索リレーターゲティング | §4.4: `on`オプション追加 | ✅ 完全 |
| フィルタ変更中のin-flight REQキャンセル | §4.4: emit()内部動作5ステップ明記 | ✅ 完全 |
| 複数RxNostrインスタンス | §12: connectStore()複数回呼びで対応 | ✅ MVP十分 |
| dispose()ライフサイクル保証 | §4.4: 5ステップの保証明記 | ✅ 完全 |
| pendingDeletions（到着順序問題） | §5.1 step 4d,8: 遅延検証追加 | ✅ 完全 |
| EOSE検知の簡素化 | §3: backward complete callback方式 | ✅ シンプル |
| イベント保存コールバック | §4.3.1: `store.changes$` で実現可能 | ✅ connectStoreのフックは不要 |

### 8.2 明示的に不採用（§12）— lumilumi視点での再評価

| spec不採用理由 | lumilumi視点 | 対応方針 |
|---|---|---|
| **postFilter:** `events$.pipe(map(...))` で代替可 | 同意。Svelte `$derived` でmuteリスト変更も追跡可能 | アプリ層で対応 |
| **status$ count/error:** countはevents$導出、エラーはrx-nostr処理 | 部分同意。**タイムアウト状態**のUI伝達手段が別途必要 | `timeout`オプション追加を提案（§3.2） |
| **batchSize:** rx-nostrのchunk/batch operatorで代替 | チャンク分割は同意。**cache-first戦略**（既存データスキップ）はStore責務 | `fetchByFilter` をv2で提案（§3.4） |
| **TanStack Queryアダプター:** v2で検討 | 同意。Phase 1はストレージ層のみ利用で十分 | `store.changes$` の公開を追加提案（§2.1） |
| **BroadcastChannel:** v2で検討 | 同意。lumilumiも現在クロスタブ同期なし | v2で対応 |

### 8.3 残存する提案（第3版反映後・優先度順）

| # | 提案 | 優先度 | 節 | 備考 |
|---|------|:------:|:--:|------|
| 1 | **Svelte 5 runes互換API** | HIGH | §2.3 | spec §13未解決事項。lumilumiの`$state.raw`パターンとの統合が必要 |
| 2 | **Optimistic Updateのロールバック通知** | HIGH | §7.3 | spec §4.5に`optimistic: true`はあるが失敗時の挙動が未定義 |
| 3 | **SyncedQueryのtimeoutオプション** | HIGH | §3.2 | lumilumiの`completeOnTimeout()`相当。EOSE未到着時のフォールバック |
| 4 | **connectStoreフィルタ除外時の挙動ドキュメント化** | MEDIUM | §7.13 | 新規。除外kindのSyncedQueryがREQ送信しても結果がStoreに入らない問題 |
| 5 | **staleTime永続化** | MEDIUM | §4.4 | 新規。最終backward完了時刻はセッション跨ぎで保持すべきか？ |
| 6 | **Addressable eventの空d-tagフォールバック明示** | MEDIUM | §7.10 | §5.1 step 6a「dタグを抽出」の`""` fallback |
| 7 | **IndexedDBクォータ超過フォールバック戦略** | MEDIUM | §7.12 | |
| 8 | **メインタイムラインのGC無しメモリリーク解消の明文化** | MEDIUM | §7.15 | auftaktのLRU管理でこの問題が解決されることをドキュメント化 |
| 9 | **localStorageスナップショットのMVP昇格検討** | MEDIUM | §6.2 | 起動時間改善 |
| 10 | **バンドルサイズ: パス別エクスポートでTree-shakeable** | MEDIUM | §7.17 | |
| 11 | **グローバルForwardReqパターンのドキュメント化** | LOW | §7.13 | spec §3の責務境界で暗黙的に対応。明示例があると良い |
| 12 | **cache-first fetchByFilter（バッチ版fetchById）** | LOW | §3.4 | v2で検討 |
| 13 | **スレッド再帰取得ヘルパー** | LOW | §7.6 | |
| 14 | **NIP-40期限切れのLRU eviction時優先削除** | LOW | §7.19 | |
| 15 | **ネガティブキャッシュのクエリレベル対応** | LOW | §3.6 | |

**対応済みにより削除:**
- ~~`store.changes$` の公開~~ → §4.3.1で対応済み
- ~~イベント保存コールバック~~ → `store.changes$` で実現可能
- ~~外部ソースの署名検証~~ → §5.3セキュリティモデルで対応済み
- ~~ビューポートベース購読パターン~~ → 責務境界明示で共存確認済み
- ~~PWA Service Worker責務分離~~ → connectStoreの責務が明確になり自明

---

## 9. 総合評価（第3版反映後）

| 観点 | 初版 | 第2版 | 第3版 | コメント |
|------|:----:|:------:|:------:|---------|
| **課題解決度** | 8/10 | 8/10 | **8/10** | 変化なし。lumilumiの主要課題を根本解決 |
| **導入コスト** | 5/10 | 6/10 | **7/10** | ↑ `store.changes$` でTanStack Query橋渡し可能に。Phase 1のハードルが大幅低下 |
| **API設計** | 6/10 | 7/10 | **8/10** | ↑ changes$、AddResult戻り値、フルフィルタ対応、セキュリティモデル。MVP APIとしてほぼ完成 |
| **パフォーマンス** | 7/10 | 7/10 | **7/10** | 変化なし |
| **Svelte統合** | 3/10 | 4/10 | **4/10** | 変化なし。Svelte 5 runes APIの具体設計が依然未解決（§13） |
| **環境考慮** | 4/10 | 5/10 | **6/10** | ↑ セキュリティモデル明記、pendingDeletionsメモリリーク対策 |
| **移行容易性** | 6/10 | 7/10 | **8/10** | ↑ 責務境界明示でlumilumiのパターンBが公式パターンとして整合。changes$でPhase 1が即座に実現可能 |

**結論:** 第3版specにより、lumilumiへの**Phase 1導入は即座に実現可能**な状態になった。最重要提案だった`store.changes$`が追加され、TanStack Queryとの橋渡しが可能に。責務境界の明示により、lumilumiのグローバルForwardReqパターンとの整合性も確認された。

**Phase 1導入に必要な残りの作業:**
1. **Svelte 5 runes adapterの具体実装**（spec §13未解決事項）
2. **Optimistic Updateのロールバック挙動定義**（§4.5に`optimistic: true`はあるが失敗時未定義）
3. **SyncedQueryのtimeoutオプション**（lumilumiの`completeOnTimeout()`相当）

**新たに発見した確認事項（第3版固有）:**

1. **staleTime永続化の必要性** — §4.4で「最終backward完了時刻」を基準とするが、この値はIndexedDBに保存されるか？セッション跨ぎで保持しないと、ページリロードのたびに常にREQ送信することになり、staleTimeの効果が半減する。

2. **connectStoreフィルタとSyncedQueryの不整合** — §3の責務境界で「connectStoreが先に呼ばれていること」を前提とするが、connectStoreのfilterで除外したkindのイベントは、SyncedQueryがREQを送信してもStoreに到達しない。この挙動をドキュメント化すべき。

3. **store.add()のPromise解決タイミング** — §5.1で `Promise<AddResult>` を返すが、これはメモリ状態の更新後に即解決するのか、IDB書き込み完了後に解決するのか？connectStoreはfire-and-forget（void）で呼ぶとあるが、publishEventがawaitする場合のレイテンシに影響する。

**auftaktの本質的価値（§7.18再掲）:** TanStack Queryは「任意のデータのキャッシュ」であり、Nostrの Replaceable/Addressable/Deletion/Ephemeral というイベント種別ごとのセマンティクスを知らない。auftaktはNostrプロトコルの状態管理ルールをストレージ層に内蔵することで、lumilumiの5層重複排除・壊れたlatestEachNaddr・Kind:5非伝搬・メインタイムラインのGC無しメモリリーク（§7.15）を根本解決する。

---

## Appendix: lumilumi固有のデータフロー図

```
                     ┌──────────────────────────────────────────────┐
                     │              lumilumi 現在の構成              │
                     └──────────────────────────────────────────────┘

  rxNostr (aggressive)              rxNostr3 (lazy-keep)
       │                                  │
       ├── ForwardReq ──┐                 ├── ForwardReq (reactions)
       ├── BackwardReq ─┤                 │
       └── (no Oneshot) │                 │
                        ↓                 ↓
                   operators.ts      reactions.ts
                   ┌──────────┐     ┌──────────────┐
                   │ tie()    │     │ handleEvent() │
                   │ uniq()   │     │ zapCheck()    │
                   │ latest() │     │ reactionCheck │
                   │ scan()   │     └───────┬───────┘
                   │ metadata │             │
                   │ bookmark │             │
                   │ status() │             │
                   └────┬─────┘             │
                        ↓                   ↓
                 ┌──────────────────────────────┐
                 │       TanStack Query          │
                 │  staleTime=1h, gcTime=1h      │
                 │  queryKeys:                   │
                 │   ["metadata", pubkey]         │
                 │   ["note", eventId]            │
                 │   ["reactions", id, type, pk]  │
                 │   ["timeline", "feed", pk]     │
                 └──────────────┬────────────────┘
                        ↓               ↓
                  Svelte derived    globalRunes.svelte.ts
                  stores             ($state.raw)
                        ↓               ↓
                  ┌──────────────────────────┐
                  │     UI Components         │
                  │  ChunkManager (virtual)   │
                  │  muteCheck (display-time)  │
                  └──────────────────────────┘
                        ↓
                  localStorage (metadata, bookmarks, settings)


                     ┌──────────────────────────────────────────────┐
                     │           auftakt導入後の構成（Phase 2）       │
                     └──────────────────────────────────────────────┘

  rxNostr (aggressive)              rxNostr3 (lazy-keep)
       │                                  │
       └──── connectStore() ──────────────┘
                        ↓
              ┌──────────────────────┐
              │   NostrEventStore     │
              │  (NIPセマンティクス)    │
              │  ┌────────────────┐  │
              │  │ IndexedDB      │  │
              │  │ + Memory LRU   │  │
              │  └────────────────┘  │
              │  auto: dedup, replace│
              │  auto: kind:5 delete │
              │  auto: since tracking│
              └──────────┬───────────┘
                         │
              ┌──────────┴───────────┐
              │                      │
         store.query()         createSyncedQuery()
              ↓                      ↓
      Svelte 5 adapter        status$ + events$
      ($state.raw)                   ↓
              ↓               muteCheck (post-filter)
              ↓                      ↓
              └──────────┬───────────┘
                         ↓
                  ┌──────────────────────────┐
                  │     UI Components         │
                  │  (ChunkManager optional)  │
                  └──────────────────────────┘
```
