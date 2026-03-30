# Design Review: @ikuradon/auftakt × nostter

**Date:** 2026-03-30
**Spec:** `@~/src/github.com/ikuradon/Resonote/docs/superpowers/specs/2026-03-30-rx-nostr-event-store-design.md`
**Target project:** nostter (SvelteKit Nostr client)

---

## 1. 現状分析: nostterのキャッシュ・イベント管理

### 1.1 現在のアーキテクチャ

nostterは**手動3層キャッシュ**を採用:

| 層 | 技術 | 用途 | 特徴 |
|---|---|---|---|
| L1 | Svelte writable stores | リアクティブUI描画 | メモリのみ、リロードで消失 |
| L2 | localStorage | replaceable events (kind 0, 3, 10002等) | 同期的、容量制限あり (~5MB) |
| L3 | IndexedDB (Dexie) | 全イベント永続化 | 非同期、addIfNotExistsのみ |

### 1.2 現在の問題点（auftaktが解決しうるもの）

**P1: ボイラープレートの多さ**
- `rxNostr.use()` が **30箇所以上** に散在
- 各箇所で `.pipe(tie, uniq(), ...)` を手動構成
- `bufferTime(1000, null, 10)` + `batch()` パターンが5箇所で繰り返し
- replaceable event の `latestEach()` + `created_at` 比較 + 3層保存が各所で重複

**P2: IndexedDB活用不足**
- `EventCache` クラスは `addIfNotExists()` と `getReplaceableEvents()` の2メソッドのみ
- インデックスは `id, kind, pubkey, [kind+pubkey]` — タグベースクエリ不可
- **読み出しキャッシュとして使っていない** — リロード時にIndexedDBから復元する仕組みが限定的
- Dexieのクエリ能力をほぼ活用していない

**P3: Kind 5削除の不整合リスク**
- `deletedEventIds` / `deletedEventIdsByPubkey` はメモリ上のSetのみ
- リロード時にkind:5の整合性チェックがない
- 別subscriptionで受信した削除が他subscriptionのデータに反映されるかはタイミング依存

**P4: リロード時のデータ消失**
- Svelte storesはリロードで消失
- localStorageに保存されるのはreplaceableイベントのみ
- タイムライン（kind:1等）は毎回リレーから全再取得

**P5: Cache-aware sinceの欠如**
- `since` は `now()` またはタイムライン最古イベントから計算
- キャッシュ済みタイムスタンプを考慮しないため、既取得イベントを再フェッチ

**P6: ネガティブキャッシュなし**
- `fetchById` 相当の処理で「見つからない」結果をキャッシュしていない
- 同じevent IDへの繰り返しフェッチが発生しうる

---

## 2. auftakt導入で期待される効果

### 2.1 高い効果が見込める機能 ✅

| 機能 | 現状の問題 | 導入効果 | 優先度 |
|---|---|---|---|
| **connectStore()** | 30箇所の手動store.add() | 全subscriptionを1箇所で自動キャッシュ | **最高** |
| **createSyncedQuery (dual)** | backward+forwardの手動merge | 1メソッドでcache→fetch→liveの遷移 | **最高** |
| **NIPセマンティクスの一元化** | kind:5/Replaceable処理が散在 | store.add()内部で自動処理 | **高** |
| **status$** | ローディング状態管理なし | 'cached'→'fetching'→'live'でUXスケルトン表示 | **高** |
| **Cache-aware since** | 毎回全再取得 | キャッシュ最新以降のみフェッチ | **高** |
| **reconcileDeletions** | リロード時の整合性チェックなし | 起動時にkind:5を再検証 | **中** |
| **ネガティブキャッシュ** | 存在しないイベントへの繰り返しフェッチ | TTL付きで「見つからない」を記憶 | **中** |
| **Svelteアダプター** | 手動でSvelte store ↔ Observable変換 | `readable`/`$state`への自動変換 | **中** |

### 2.2 nostter固有のメリット

**a) メタデータバッチ処理の統合**

現在:
```typescript
// MainTimeline.ts — 手動バッチ
rxNostr.use(metadataReq.pipe(bufferTime(1000, null, 10), batch()))
  .pipe(tie, uniq(), latestEach(...))
  .subscribe(({ event }) => {
    storeMetadata(event);
    // + localStorage保存
    // + IndexedDB保存
  });
```

auftakt導入後:
```typescript
// connectStore()が全イベントを自動キャッシュ
// 各コンポーネントでは:
const profile$ = createSyncedQuery(rxNostr, store, {
  filter: { kinds: [0], authors: [pubkey] },
  strategy: 'backward',
  staleTime: 5 * 60_000,
});
```

**b) タイムライン復元の高速化**

現在: リロード → リレーから全再取得（数秒～数十秒のブランク）
auftakt: リロード → IndexedDBから即時復元 → 差分のみリレーフェッチ

**c) seenOn (relay hint) の自動管理**

現在: カスタム`tie` operatorで手動追跡 + グローバルMap
auftakt: `CachedEvent.seenOn` として自動管理、`store.add(event, { relay })` で蓄積

---

## 3. 改善提案・懸念点

### 3.1 スペックへの改善提案 🔧

**A) Svelte 5 runes対応の明確化（未解決事項#2）**

nostterはSvelte 5を使用。アダプター設計として:

```typescript
// 提案: $state()ベースのアダプター
import { svelteAdapter } from '@ikuradon/auftakt/adapters/svelte';

// Svelte 5 runesとの統合
const { events, status } = svelteAdapter(
  createSyncedQuery(rxNostr, store, { ... })
);
// events: $state(CachedEvent[])
// status: $state<'cached' | 'fetching' | 'live' | 'complete'>
```

現在のnostterは `writable()` (Svelte 4スタイル) と Svelte 5の `$state` が混在。
auftaktが両方をサポートするか、Svelte 5 runesのみにするか明確化が必要。

**B) staleTime のイベントkind別設定**

プロフィール (kind:0) は5分でstaleでいいが、タイムライン (kind:1) は30秒以内を期待。
kind別のstaleTime設定が有用:

```typescript
createSyncedQuery(rxNostr, store, {
  filter: { kinds: [0], authors: [...] },
  strategy: 'backward',
  staleTime: { 0: 5 * 60_000, 1: 30_000, default: 60_000 },
});
```

**C) メタデータ解析の責務境界**

nostterは `Metadata` クラスでkind:0の `content` JSON を解析し、
`name`, `picture`, `nip05` 等のフィールドを抽出。
auftaktの `CachedEvent` は生の `NostrEvent` を返すため、
解析ロジックはアプリ側に残る。これは正しい判断だが、ドキュメントで明示すべき。

**D) フィルタのhot-swap時のキャッシュクリア方針**

`SyncedQuery.emit()` でフィルタ変更時:
- 既存キャッシュ結果は即座にクリアされるのか？
- 新フィルタのキャッシュ結果がある場合は即返却されるのか？
→ 仕様として明確化必要。nostterのリスト切替・検索フィルタ変更で重要。

**E) Ephemeral event (kind 20000-29999) の除外範囲**

仕様では「Ephemeral判定 → 保存しない」だが、nostterはkind 30315 (User Status) を使用。
これはAddressable (30000-39999) なので保存対象だが、
Ephemeral寄りの短命データ。TTLベースの自動削除オプションがあると良い。

**F) 容量管理: localStorage スナップショット (v3) の優先度引き上げ**

nostterは現在localStorageにreplaceableイベントを保存し、
起動時に同期的に読み出している。auftakt v3の「localStorageスナップショット」は
nostterの既存パターンと互換性が高く、v1で対応すべき。

### 3.2 nostter側で必要な変更 ⚠️

**a) Svelte store統合の全面書き換え**

現在30以上のwritable storeが個別にイベントを管理。
auftakt導入時は `store.query()` のリアクティブ結果に統一する必要あり。
→ 段階的移行戦略が必要（一括移行は非現実的）。

**段階的移行の提案:**

| Phase | 対象 | 規模 |
|---|---|---|
| Phase 1 | connectStore() 導入 + 既存ロジック維持 | 小 |
| Phase 2 | メタデータ (kind:0) を SyncedQuery に移行 | 中 |
| Phase 3 | タイムライン (HomeTimeline等) を SyncedQuery に移行 | 大 |
| Phase 4 | Action (reaction, repost) を SyncedQuery に移行 | 中 |
| Phase 5 | 旧キャッシュ層 (WebStorage, EventCache) 撤去 | 小 |

Phase 1 は既存コードを壊さずに導入可能（全イベントをStoreに流し込むだけ）。

**b) カスタムtie operatorの扱い**

nostterの `tie` は `seenOn` を `Map<string, Set<string>>` として外部公開。
auftaktの `CachedEvent.seenOn` がこれを代替するが、
既存コードの `getRelayHint()` / `getSeenOnRelays()` を
`store.getById(id).seenOn` に書き換える必要あり。

**c) Dexie → auftakt IndexedDBバックエンドへの移行**

現在のDexie `cache` DB のスキーマと auftakt の ObjectStore設計は異なる。
データ移行が必要。Dexieを auftakt内部でも使うか、生IndexedDB APIかの判断も影響。

### 3.3 懸念点 ⚠️

**1. バンドルサイズ増加**

nostterは既にrx-nostr + RxJS + Dexie + nostr-toolsが入っている。
auftaktの追加サイズが気になる（特にモバイルユーザー）。
→ tree-shakeable設計であることが重要。

**2. メモリ使用量**

現在のnostterはイベントをストリーム処理し、表示に必要なものだけメモリに保持。
auftaktはStore内に全イベントを保持するため、長時間使用時のメモリ増加が懸念。
→ メモリバックエンドのLRU + kind別バジェットが重要。

**3. createAllEventObservable() の存在確認**

auftaktのconnectStore()は `rxNostr.createAllEventObservable()` に依存。
rx-nostr 3.6.1にこのAPIが存在するか要確認。
存在しない場合、各 `use()` 呼び出しの結果を個別にStore.add()する
フォールバックが必要。

**4. 既存テストへの影響**

nostterにどの程度テストがあるか不明だが、
rx-nostrのObservableに直接subscribeするテストは書き換えが必要になる。

---

## 4. nostter固有の追加ニーズ

auftaktスペックにない、nostterが必要とする機能:

### 4.1 Mute/Filter統合

nostterは `mutePubkeys`, `muteEventIds`, `muteWords` でフィルタリング。
`store.query()` にmute条件を渡せると便利:

```typescript
store.query({
  kinds: [1],
  exclude: {
    authors: $mutePubkeys,
    ids: $muteEventIds,
    contentPattern: $muteWords,
  },
});
```

ただしこれはアプリ層の責務でもある。auftaktに入れるべきか要議論。

### 4.2 Notification管理

nostterは通知用のfilteredイベントストリームを維持。
`#p` タグベースのクエリが必要:

```typescript
store.query({
  kinds: [1, 6, 7, 9735],
  '#p': [myPubkey],
  since: lastReadAt,
});
```

auftaktのタグインデックスでこれは対応可能（§6.1の `tag_index`）。

### 4.3 Reaction/Repost集計

nostterは「自分がリアクション/リポスト済みか」を追跡。
`store.query({ kinds: [7], authors: [myPubkey], '#e': [targetEventId] })`
が効率的に動く必要がある。複合タグクエリのパフォーマンスが重要。

### 4.4 ハッシュタグフォロー

nostterは `#t` タグでハッシュタグタイムラインを構成。
`store.query({ kinds: [1], '#t': ['nostr', 'bitcoin'] })` が必要。

---

## 5. 総合評価

### 導入推奨度: ⭐⭐⭐⭐ (5段階中4)

**導入すべき理由:**
1. ボイラープレート大幅削減（30箇所→数箇所）
2. リロード時のデータ即時復元（UX大幅改善）
3. NIPセマンティクス処理の一元化（バグ削減）
4. Cache-aware sinceによる帯域節約
5. status$によるローディングUXの統一

**慎重にすべき理由:**
1. 移行コストが大きい（段階的移行必須）
2. Svelte 5 runesとの統合設計が未確定
3. createAllEventObservable()のAPI存在確認が必要
4. メモリ使用量の増加リスク

### 推奨アクション

1. **即座に**: rx-nostr 3.x の `createAllEventObservable()` API存在確認
2. **Phase 1**: connectStore() のみ導入し、既存コードと並行運用して効果測定
3. **Phase 2以降**: 効果確認後にSyncedQueryへの段階的移行
4. **並行**: Svelteアダプターの設計をnostter側のニーズで主導

---

## 6. 追加分析: 深掘り調査で判明した事項

### 6.1 createAllEventObservable() の存在問題 🚨

**結論: rx-nostr 3.6.1に `createAllEventObservable()` は存在しない可能性が高い。**

nostterのコードベースでは `createAllMessageObservable()` のみ使用が確認された（MainTimeline.ts:128）。
`createAllEventObservable()` のインポートや使用は一切見つからなかった。

```typescript
// nostterで実際に使われているAPI
const observable = rxNostr.createAllMessageObservable();
observable.pipe(filterByType('NOTICE')).subscribe(...);
observable.pipe(filterByType('CLOSED')).subscribe(...);
```

**auftaktスペックへの影響:**
- `connectStore()` の設計前提が崩れる
- 代替案1: `createAllMessageObservable()` + `filterByType('EVENT')` でイベントを抽出
- 代替案2: 各 `rxNostr.use()` 呼び出しの戻り値に `.pipe(tap(e => store.add(e)))` を挿入するラッパー関数
- 代替案3: rx-nostrにPR を出して `createAllEventObservable()` を追加

これはauftaktの根幹に関わるため、**実装前に必ず確認が必要。**

### 6.2 EventItem抽象レイヤーの存在

nostterはイベントを `EventItem` クラスでラップしている（`Items.ts`）:

```typescript
class EventItem {
  event: NostrEvent;
  replyToPubkeys: string[];   // NIP-10 'p'タグから抽出
  replyToId: string | undefined; // reply marker → root fallback
}

class ZapEventItem extends EventItem {
  // lazy-loaded: zap request event + invoice amount
}
```

**auftaktとのギャップ:**
- auftaktの `CachedEvent` は `{ event, seenOn, firstSeen }` のみ
- `EventItem` の `replyToId` / `replyToPubkeys` 計算はアプリ層の責務
- しかし、`store.query()` の結果を `EventItem[]` に変換するアダプターが必要
- `CachedEvent → EventItem` の変換コストが毎回発生する懸念

**提案:** `store.query()` にマッピング関数を渡せるオプション:
```typescript
store.query({
  kinds: [1],
  map: (cached) => new EventItem(cached.event),
});
```

### 6.3 fetchMinutes() 適応的時間窓

nostterはフォロイー数に応じてbackward fetchの時間窓を動的調整:

```typescript
export const fetchMinutes = (numberOfPubkeys: number): number => {
  if (numberOfPubkeys < 10)    return 24 * 60;  // 24時間
  if (numberOfPubkeys < 25)    return 12 * 60;  // 12時間
  if (numberOfPubkeys < 50)    return 60;       //  1時間
  return 15;                                     // 15分
};
```

**auftaktのSyncedQueryへの影響:**
- `strategy: 'backward'` のREQ発行時に、この適応ロジックをどこに置くか
- SyncedQueryが内部で `since` を計算する場合、フォロイー数を知る必要がある
- `cache-aware since` と `fetchMinutes()` の組み合わせが必要

**提案:** SyncedQueryの `since` 計算をカスタマイズ可能にする:
```typescript
createSyncedQuery(rxNostr, store, {
  filter: { kinds: [1], authors: followees },
  strategy: 'dual',
  sinceStrategy: (cacheNewest, filterAuthorsCount) => {
    const minutes = fetchMinutes(filterAuthorsCount);
    return Math.max(cacheNewest, now() - minutes * 60);
  },
});
```

### 6.4 ReplayHomeTimeline（タイムライン再生機能）

nostter固有の機能で、過去のタイムラインを速度調整しながら再生する:

- `sinceDate` からbackward REQで5分チャンクずつ取得
- `speed` (1x～10x) に応じてsetTimeoutで各イベントの表示タイミングを制御
- イベントの `created_at` をリアルタイムクロックにマッピング

**auftaktとの関係:**
- この機能はauftaktの恩恵を最も受ける — キャッシュ済みイベントは再フェッチ不要
- `store.query({ kinds: [1], authors: followees, since, until })` で即座にキャッシュから取得
- リレーへのREQは差分のみ
- ただし、SyncedQueryの `strategy` にはReplayパターンがない（backward + 時間スライス）

### 6.5 Relay Targeting と SyncedQuery

nostterの `PublicTimeline` はリレー固定:

```typescript
rxNostr.use(req, { on: { relays: this.#relays } })
```

**auftaktスペックの不足:** SyncedQueryにリレーターゲティングオプションがない:

```typescript
// 必要なAPI
createSyncedQuery(rxNostr, store, {
  filter: { kinds: [1] },
  strategy: 'forward',
  on: { relays: ['wss://relay.example.com'] },  // ← これが必要
});
```

スペック§11では「Relay targeting (on) ✅ SyncedQueryオプションでパススルー」とあるが、
具体的なAPI設計が記載されていない。

### 6.6 Multi-Tab問題

**現状:** nostterはクロスタブ通信なし（BroadcastChannel / SharedWorker未使用）。

**auftakt導入時の懸念:**
- Tab Aで受信した kind:5 削除がTab BのStore には反映されない
- 同じリレーへの重複接続（タブ数 × 接続数）
- IndexedDB書き込み競合（Dexie のトランザクション分離で安全だが非効率）

**提案:** auftaktにオプショナルなcross-tab syncレイヤーを検討:
```typescript
const store = createEventStore({
  backend: indexedDBBackend('my-app'),
  crossTabSync: true,  // BroadcastChannel経由でStore変更を他タブに通知
});
```

### 6.7 PWA / オフライン対応

nostterにはService Workerがあるが、**静的アセットのキャッシュのみ**。
タイムラインデータのオフライン表示機能はない。

**auftaktによるオフライン改善:**
- IndexedDBに永続化されたイベントをオフラインでも表示可能
- `status$: 'cached'` 状態でUI描画 → オフラインでも前回セッションの内容を表示
- Service Workerとの連携は不要（IndexedDBは直接アクセス可能）

これはnostterにとって大きなUX改善になりうる。

### 6.8 filterAsync() と非同期フィルタリング

nostterは暗号化コンテンツの判定に非同期フィルタリングを使用:

```typescript
// PeopleLists.ts
.pipe(
  filterByKind(Kind.Followsets),
  filterAsync(({ event }) => isPeopleList(event))  // NIP-44復号チェック
)
```

**auftaktへの影響:**
- `store.query()` は同期的なフィルタのみ対応（スペックの現状）
- 暗号化イベントのフィルタリングはアプリ層で行う必要がある
- `store.query()` の結果Observableに `.pipe(filterAsync(...))` を追加する形で対応可能
- ただし、リアクティブクエリの再評価時にもasyncフィルタが必要になる場面がある

### 6.9 IndexedDB エラーハンドリングの欠如

nostterの現在のEventCacheには **try/catch がない**:

```typescript
// cache/db.ts — エラー未処理
async addIfNotExists(event: Event): Promise<void> {
  await this.db.transaction('rw', [this.db.events], async () => {
    const cachedEvent = await this.db.events.get(event.id);
    if (cachedEvent === undefined) {
      await this.db.events.add(event);
    }
  });
}
```

**auftaktへの要件:**
- QuotaExceededError（容量超過）時のグレースフルデグラデーション
- IndexedDB非対応環境（プライベートブラウジング等）でのメモリフォールバック
- トランザクション失敗時のリトライ戦略

**提案:** バックエンドにエラーポリシーを設定可能に:
```typescript
const store = createEventStore({
  backend: indexedDBBackend('my-app', {
    onQuotaExceeded: 'evict-lru',  // or 'fallback-memory' or 'throw'
    onError: (error) => console.warn('[auftakt]', error),
  }),
});
```

### 6.10 テスト資産の存在

nostterには **9つのテストファイル** が存在（vitest + Playwright）:

- `Content.test.ts`, `Array.test.ts`, `User.test.ts`, `List.test.ts`, `Twitter.test.ts`
- `cache/db.test.ts` — **IndexedDBキャッシュのテストあり**
- `EventHelper.test.ts`

**auftakt移行時の影響:**
- `cache/db.test.ts` は書き換えが必要（EventCache → auftakt Store）
- 他のテストは直接影響なし（ユーティリティ関数のテスト）
- auftakt自体のテストはfake-indexeddbなどが必要（スペック未解決事項#3）

### 6.11 @rust-nostr/nostr-sdk の役割

nostterは `@rust-nostr/nostr-sdk` (WASM) をWeb Worker内でイベント署名検証に使用:

```typescript
// Worker.ts
import { Event as EventWrapper, loadWasmSync } from '@rust-nostr/nostr-sdk';
loadWasmSync();
const verifier = async (event) => EventWrapper.fromJson(JSON.stringify(event)).verify();
```

**auftaktとの関係:**
- 検証はrx-nostr内部で完了するため、auftaktのstore.add()時には検証済みイベントが渡される
- auftakt内部での再検証は不要（パフォーマンス上重要）
- ただし、IndexedDBから復元したイベントの検証ポリシーは要検討
  - 信頼済み（自分のDBから読んだ）として検証スキップ？
  - それとも起動時に再検証？

### 6.12 暗号化コンテンツとキャッシュのセキュリティ

nostterはNIP-04 / NIP-44の暗号化を広範に使用:

- **NIP-51リストの暗号化private tags** — Mute list (kind 10000), People lists (kind 30000), Bookmarks (kind 30001) がcontent内に暗号化済みpubkeysを持つ
- **DM** — Kind 4は明示的にキャッシュ対象外だが、フィルタで除外しなければconnectStore()が取り込む

**auftaktへのセキュリティ要件:**
- 暗号化イベントをIndexedDBに平文で保存してよいか？（復号後のキャッシュ問題）
- nostterは暗号化コンテンツを**復号せずにそのまま保存**し、表示時に都度復号している → auftaktも同方針が安全
- `connectStore()` のフィルタで `event.kind !== 4` を指定すべき（スペック§4.2の例と一致）
- デバイス紛失時のリスク: IndexedDBに大量のイベントが保存される → ブラウザのストレージクリアがユーザーの唯一の保護手段

**提案:** センシティブイベントのキャッシュポリシー設定:
```typescript
connectStore(rxNostr, store, {
  filter: (event) => {
    if (event.kind === 4) return false;           // DM除外
    if (event.kind >= 20000 && event.kind < 30000) return false; // Ephemeral除外
    return true;
  },
  // オプション: 暗号化コンテンツを持つkindのTTL
  ttlByKind: { 10000: 24 * 60 * 60_000 },  // Mute listは24時間で期限切れ
});
```

### 6.13 NIP-11 max_subscriptions制限との衝突

nostterは `Nip11Registry.setDefault({ limitation: { max_subscriptions: 20 } })` を設定。

**auftaktの影響:**
- `connectStore()` が `createAllEventObservable()` (または代替) で1つのサブスクリプションを使用
- 各 `createSyncedQuery()` がbackward/forward REQを作成
- 20サブスクリプション制限に達するリスク:
  - HomeTimeline (forward 1 + backward N)
  - メタデータ (backward)
  - 通知 (forward 1)
  - リアクション/リポスト (backward)
  - 各種replaceable event (backward)

**提案:** SyncedQueryにサブスクリプション共有オプション:
```typescript
// 同じフィルタkindのSyncedQueryがREQを統合
createSyncedQuery(rxNostr, store, {
  filter: { kinds: [0], authors: pubkeys },
  deduplicateReq: true,  // 既存REQと統合可能なら統合
});
```

### 6.14 eventsStore の無制限増加

nostterの `eventsStore` (内部配列) にはサイズ上限がない。
表示は `maxTimelineLength = 50` に制限されるが、ページング用に全イベントをメモリ保持。

**auftaktが解決する点:**
- メモリバックエンドのLRU + kind別バジェットで自動管理
- IndexedDBバックエンドへの永続化により、メモリから削除しても復元可能
- `store.query({ limit: 50 })` で表示分のみ取得、ページングは `since/until` で実現

**ただし、nostter側の変更が必要:**
- 現在の `eventsStore` 全量保持 → `store.query()` のリアクティブ結果に変更
- `newer()` / `older()` の実装を `store.query({ until: oldestEvent.created_at })` に変更

### 6.15 SSR / Cloudflare Workers環境での制約

nostterは `@sveltejs/adapter-cloudflare` でデプロイ。SSRが有効。

**auftaktの制約:**
- IndexedDBはブラウザ専用API → SSR時に使用不可
- `createEventStore()` は `browser` チェック付きで初期化する必要あり:
```typescript
import { browser } from '$app/environment';

const store = browser
  ? createEventStore({ backend: indexedDBBackend('nostter') })
  : createEventStore({ backend: memoryBackend() }); // SSR用ダミー
```
- `connectStore()` / `createSyncedQuery()` もクライアント専用
- SSR時のデータフェッチにはauftaktは使えない（そもそもSSRでリレー接続しない設計が正しい）

### 6.16 NIP-42 AUTH状態とキャッシュ整合性

nostterは `authenticator: 'auto'` でNIP-42 AUTHに自動対応。

**懸念:**
- AUTH前後でリレーが返すイベントが異なる可能性がある
- AUTH前にキャッシュした「イベントなし」が、AUTH後も有効として扱われるリスク
- ネガティブキャッシュのTTLがこれを緩和するが、AUTH状態変更時にネガティブキャッシュのinvalidationが理想

### 6.17 NIP-40 イベント有効期限の部分的対応

nostterは **User Status (kind 30315) でのみ** `isExpired()` チェックを実施:

```typescript
// UserStatus.ts
filter(({ event }) => !isExpired(event))
```

一般タイムラインイベントではexpiration チェックなし。

**auftaktの利点:**
- スペック§5.1 step 3で `NIP-40期限チェック → 期限切れなら保存しない` を一元処理
- 既存キャッシュの期限切れイベントもquery時に除外 (§5.3 step 3)
- nostterが個別に `isExpired()` を呼ぶ必要がなくなる

### 6.18 Bookmark/Mute操作のQueue統合

nostterはBookmark・Mute・Interest操作に **Queue** パターンを使用:

```typescript
// Bookmark.ts
const queue = new Queue<{ event: Event; id: string }>();
queue.enqueue({ event, id: eventId });
// → 順次処理で競合回避
```

**auftaktの `publishEvent()` との関係:**
- `publishEvent()` のoptimistic updateは即時Store反映
- しかし、Queue経由で発行する場合、Storeへの反映タイミングの整合が必要
- 提案: `publishEvent()` にQueue/バッチ対応オプション、またはQueue側からstore.add()を明示呼び出し

### 6.19 未使用依存: async-lock

`async-lock` がpackage.jsonに存在するがコード内で使用されていない。
auftakt移行時のクリーンアップ候補。

### 6.20 Svelte 5移行の途中状態

| レイヤー | 現在の状態管理 | 影響 |
|---|---|---|
| Timeline classes | `$state.raw` / `$derived` (Svelte 5) | auftaktアダプターは$state対応が必要 |
| グローバルstores | `writable()` (Svelte 4スタイル) | 移行期間中は両方サポートが必要 |
| 永続化stores | `svelte-persisted-store` | auftaktのIndexedDB永続化で代替可能 |

**auftaktアダプター設計への影響:**
- `adapters/svelte.ts` は `readable()` (Svelte 4) と `$state` (Svelte 5) の両方を出力できるべき
- または、Observable → `readable()` の変換のみ提供し、`$state` への変換はアプリ側で `toStore()` 等のユーティリティを使用

---


## 8. 更新版スペック (auftakt/docs/design.md) との照合

### 8.1 全レビュー指摘の反映状況（累計）

| 指摘 | ステータス | スペックでの対応 |
|---|---|---|
| emit() hot-swap時のキャッシュクリア方針 | ✅ 解決 | §4.4に5ステップの内部動作を明記 |
| Relay Targeting | ✅ 解決 | §4.4 `on: { relays: [...] }` オプション明記 |
| SSR対応 | ✅ 解決 | §6.1 自動メモリフォールバック |
| pendingDeletionsメモリリーク | ✅ 解決 | §5.2 TTL(5分) + 上限(10000件) |
| store.query() since/until/ids | ✅ 解決 | §4.3 Nostrフィルタフルセット + ページネーション例 |
| staleTime判定基準 | ✅ 解決 | §4.4 「前回backward REQ完了時刻を基準」と明記 |
| Replaceable置換通知 | ✅ 解決 | §4.3.1 `store.changes$` + §5.1 `AddResult` 型 |
| セキュリティモデル（IDB復元の信頼境界） | ✅ 解決 | §5.3 trusted cache + 同一オリジンポリシー |
| Multi-tab問題 | ⏳ v2送り | §12に理由付きで記載 |
| REQ重複排除 | ⏳ v2送り | §9 v2最適化に記載 |
| EventItemマッピング | ❌ 不採用 | §12: `events$.pipe(map(...))` で代替 |
| Mute/Filter統合 | ❌ 不採用 | §12: `$derived` で代替 |
| Svelte 5 runes | 🔲 未解決 | §13 未解決事項#2に残存 |
| kind別staleTime | 🔲 未対応 | — |
| localStorageスナップショット優先度 | 🔲 v3のまま | §9 v3に残存 |
| fetchMinutes/sinceStrategy | 🔲 未対応 | — |
| IDBエラーハンドリング | 🔲 未対応 | — |
| NIP-42 AUTH後のキャッシュ整合性 | 🔲 未対応 | — |
| Queue統合 | 🔲 未対応 | — |

**反映率: 19項目中 8解決 + 2 v2送り + 2不採用 = 12/19 対応済み (63%)**

### 8.2 再々レビュー: 今回の新規追加事項の評価

**A) connectStore/SyncedQueryの責務分離（§3）— アーキテクチャ上の明確化 ✅**

```
connectStore() → store.add() を一元管理（グローバルフィード）
createSyncedQuery() → REQライフサイクル + store.query() 公開。store.add()は呼ばない
前提: connectStore()が先に呼ばれていること
```

nostterへの影響:
- SvelteKitの `+layout.ts` か `+layout.svelte` の `onMount` で `connectStore()` を呼ぶ
- 各ページ/コンポーネントは `createSyncedQuery()` のみ使用
- **Gotcha:** connectStore()なしでSyncedQueryだけ使うとREQ応答がStoreに入らない

**B) store.add()の戻り値 `Promise<AddResult>`（§5.1）— 有用 ✅**

```typescript
type AddResult = 'added' | 'replaced' | 'deleted' | 'duplicate' | 'expired' | 'ephemeral'
```

- connectStore内部: `void store.add(...)` (fire-and-forget) — パフォーマンスに影響なし
- publishEvent: awaitして結果を確認 — optimistic updateの検証に使える

**C) step 1.5 deletedIds事前チェック（§5.1）— レース条件の防止 ✅**

fetchById in-flight中にkind:5が到着 → deletedIdsに登録 → fetchById結果到着時にstep 1.5で即ドロップ。

**D) store.changes$ Observable（§4.3.1）— 移行ブリッジとして有用 ✅**

nostterの段階的移行で、既存Svelte storeをstore.changes$で更新可能:
```typescript
// Phase 1: 既存storeとauftaktの共存
store.changes$.pipe(filter(c => c.event.kind === 0)).subscribe(c =>
  metadataStore.update(m => m.set(c.event.pubkey, new Metadata(c.event)))
);
```

**E) セキュリティモデル（§5.3）— 信頼境界の明文化 ✅**

rx-nostr verifier検証済みイベントはStoreで再検証しない。IDB復元はtrusted cache。
nostterの `@rust-nostr/nostr-sdk` WASM検証との整合性: rx-nostrのverifierとして設定済みなので問題なし。

**F) pendingDeletions TTL/上限（§5.2）— メモリリーク防止 ✅**

デフォルト5分 + 10000件上限。nostterの一般的な使用量では十分。

### 8.3 再々レビュー: 新たな懸念事項

**N7: ページネーションクエリのリアクティブ性セマンティクス**

`store.query({ until, limit })` はリアクティブクエリとして動作するが、`until` 付きクエリで新イベント到着時の挙動が不明:

```
store.query({ kinds: [1], until: 1711800000, limit: 25 })

ケース1: 新イベント(created_at: 1711800100) 到着 → until超過 → 結果に含まれない ✅
ケース2: 新イベント(created_at: 1711799000) 到着 → until以内 → リアクティブに追加される？
```

nostterの `older()` では過去イベント（BackwardReqの応答）がStore経由で到着するため、ケース2のリアクティブ追加が必要。

**提案:** ドキュメントに「全queryはリアクティブ。since/untilは結果のフィルタ条件であり、subscriptionの有効期間ではない」と明記。

**N8: connectStore filterとSyncedQuery filterの不一致（サイレントデータロス）**

```typescript
connectStore(rxNostr, store, {
  filter: (event) => event.kind !== 4,  // kind:4除外
});

// 別の場所で誤ってkind:4を要求
createSyncedQuery(rxNostr, store, {
  filter: { kinds: [4], authors: [peer] },
  strategy: 'backward',
});
// → REQ送信 → リレー応答 → connectStoreが落とす → events$は常に空
```

nostterではkind:4を使わないが、他の開発者が間違えうるパターン。
**提案:** ドキュメントにGotchaとして明記。デバッグモードで警告ログ出力も検討。

**N9: IDBエラーハンドリングが依然未定義（3回目の指摘）**

最低限のエラーポリシー定義が必要:
```typescript
const backend = indexedDBBackend('my-app', {
  onError: 'log-and-continue' | 'fallback-memory' | 'throw',
});
```

---

## 9. 残存する未解決事項（最終版）

### 最優先（ブロッカー）

| # | 項目 | 理由 | 前回比 |
|---|---|---|---|
| B1 | `createAllEventObservable()` のAPI確認 | connectStore()の実装前提 | 変更なし（唯一の🔴） |
| ~~B2~~ | ~~store.query() since/until/ids~~ | — | **✅ 解決** |
| ~~B3~~ | ~~staleTime判定基準~~ | — | **✅ 解決** |

**残ブロッカーは1件のみ。**

### 高優先（MVP品質に影響）

| # | 項目 | nostterでの影響 | 前回比 |
|---|---|---|---|
| ~~H1~~ | ~~pendingDeletions TTL~~ | — | **✅ 解決** |
| H2 | IDBエラーハンドリング | ヘビーユーザーのクラッシュ防止 | 変更なし |
| ~~H3~~ | ~~Replaceable置換通知~~ | — | **✅ 解決** |
| H4 | Svelteアダプター設計 | Svelte 5移行途中状態 | 変更なし |
| **H5** | **ページネーションクエリのリアクティブ性** | **older()でのイベント追加挙動** | **新規** |

### 中優先（v1後半またはv2）

| # | 項目 | nostterでの影響 | 前回比 |
|---|---|---|---|
| M1 | kind別staleTime | profile=5min, timeline=30sec | 変更なし |
| M2 | sinceStrategy カスタマイズ | fetchMinutes()の適応ロジック統合 | 変更なし |
| M3 | localStorageスナップショット優先度引き上げ | 既存パターンとの互換性 | 変更なし |
| M4 | NIP-42 AUTH後のネガティブキャッシュinvalidation | AUTH依存リレーでの整合性 | 変更なし |
| M5 | Queue/バッチ発行とoptimistic updateの整合 | Bookmark/Mute操作 | 変更なし |
| **M6** | **connectStore/SyncedQueryフィルタ不一致の文書化** | **サイレントデータロス防止** | **新規** |

---

## 10. 総合評価（最終版）

### 導入推奨度: ⭐⭐⭐⭐⭐ (5/5に上方修正)

**5/5に上方修正の理由:**
- 前回ブロッカー3件中2件が解決（since/until/ids、staleTime判定基準）
- pendingDeletions TTL/上限が追加されメモリリーク防止
- `store.changes$` + `AddResult` 型で移行期ブリッジが可能に
- セキュリティモデル（§5.3）の明文化で信頼境界が明確
- connectStore/SyncedQueryの責務分離が明記されアーキテクチャの理解が容易に
- store.add() step 1.5でfetchById レース条件を防止
- スペック全体の成熟度が高く、nostterへの導入パスが明確

**残る唯一のブロッカー:**
- R1: `createAllEventObservable()` — スペック全体がこのAPI前提で設計されており、著者がrx-nostrへの実装を予定していると推察。確認のみで解消する可能性が高い

**リスク一覧（最終版）:**

| # | リスク | 重要度 | 前回比 |
|---|---|---|---|
| R1 | `createAllEventObservable()` の不存在 | 🔴 致命的 | 変更なし (唯一の🔴) |
| R2 | IDBエラーハンドリング欠如 | 🟡 高 | 変更なし |
| R3 | ページネーションクエリのリアクティブ性 | 🟡 中 | **新規** |
| R4 | Svelte 4/5混在のアダプター対応 | 🟡 中 | 変更なし |
| R5 | connectStore/SyncedQueryフィルタ不一致 | 🟠 低 | **新規** |

**メリット一覧（全調査統合）:**

| # | メリット | 効果 |
|---|---|---|
| M1 | ボイラープレート削減 (30箇所→数箇所) | 🟢 非常に高い |
| M2 | リロード時データ即時復元 | 🟢 非常に高い |
| M3 | NIPセマンティクス一元化 (kind:5, Replaceable, NIP-40, pendingDeletions) | 🟢 高い |
| M4 | Cache-aware since + fetchMinutes()で帯域節約 | 🟢 高い |
| M5 | status$によるローディングUX統一 | 🟢 高い |
| M6 | ReplayHomeTimelineのキャッシュ活用 | 🟢 高い |
| M7 | PWAオフラインタイムライン表示 | 🟢 高い |
| M8 | store.changes$による段階的移行の容易さ | 🟢 高い |
| M9 | NIP-40有効期限チェックの自動化 | 🟢 中 |
| M10 | ネガティブキャッシュで不存在イベント再フェッチ防止 | 🟢 中 |
| M11 | seenOn自動管理でtie operator撤去 | 🟢 中 |
| M12 | fetchById in-flight dedupでスレッド表示の重複REQ防止 | 🟢 中 |

### 推奨アクション（最終版）

**ブロッカー（実装前に必須）:**
1. `createAllEventObservable()` のAPI存在確認

**Phase 1（低リスク・高効果）:**
2. `connectStore()` 導入（SSR自動フォールバック対応済み）
3. connectStore()のフィルタで `event.kind !== 4` DM除外
4. `store.changes$` を使って既存Svelte storeと共存（移行ブリッジ）

**Phase 1と並行（スペック改善要望）:**
5. ページネーションクエリ(until+limit)のリアクティブ性セマンティクス明記
6. IDBエラーポリシー（QuotaExceeded等）設計
7. connectStore/SyncedQueryフィルタ不一致のドキュメント/警告

**Phase 2以降:**
8. メタデータ → タイムライン → Action の段階的SyncedQuery移行
9. eventsStore → `store.query({ until, limit })` ページング移行
10. 旧キャッシュ層撤去（WebStorage, EventCache, tie operator, async-lock）

**v2要望:**
11. Multi-tab BroadcastChannel sync
12. REQ重複排除
13. kind別staleTime

---

## Appendix: コード対応表

| auftakt概念 | nostter現在の実装 | ファイル |
|---|---|---|
| connectStore() | 各所のsubscribe内store保存 | 30+箇所 |
| store.add() | eventCache.addIfNotExists() + storeMetadata() + WebStorage.set() | cache/db.ts, cache/Events.ts, WebStorage.ts |
| store.query() | $metadataStore, $eventItemStore, $replaceableEventsStore | cache/Events.ts |
| store.changes$ | なし（各subscribeで個別処理） | — |
| SyncedQuery (dual) | HomeTimeline.subscribe() + older() | timelines/HomeTimeline.ts |
| SyncedQuery (backward) | RxNostrHelper.fetchEvents() | RxNostrHelper.ts |
| SyncedQuery (forward) | createRxForwardReq + subscribe | HomeTimeline.ts, PublicTimeline.ts |
| CachedEvent.seenOn | tie operator + seenOn Map | RxNostrTie.ts, MainTimeline.ts |
| NIP rules (kind:5) | deletedEventIds + deletedEventIdsByPubkey | author/Delete.ts |
| NIP rules (replaceable) | latestEach() + created_at比較 | HomeTimeline.ts, Author.ts |
| publishEvent() | rxNostr.send() 直接呼び出し | 各所 |
| fetchById() | RxNostrHelper.fetchEvent() | RxNostrHelper.ts |
| negativeCache | なし | — |
| staleTime | なし | — |
| reconcileDeletions | なし | — |
