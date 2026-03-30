# @ikuradon/auftakt MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** rx-nostr専用のリアクティブイベントストアを構築し、Nostrクライアントのキャッシュボイラープレートを一掃する

**Architecture:** Event Store方式。rx-nostrがリレーからイベントを取得し、Storeが NIPセマンティクス（Replaceable/Addressable/Deletion/Expiration）に基づいて保存・クエリ・更新する。UIはStoreのreactive queryに購読する。connectStore()がグローバルフィード、createSyncedQuery()がREQライフサイクル+store.query()のreactive結果を公開する。

**Tech Stack:** TypeScript, RxJS 7.x, rx-nostr 3.x, nostr-typedef, Vitest, fake-indexeddb

**Spec:** `docs/design.md`

---

## File Structure (実装後の最終状態)

```
@ikuradon/auftakt/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                    # メインエントリポイント
│   ├── types.ts                    # 共通型定義
│   ├── core/
│   │   ├── store.ts                # NostrEventStore本体（add, query, fetchById, changes$）
│   │   ├── nip-rules.ts            # イベント分類・Replaceable/Addressable判定
│   │   ├── filter-matcher.ts       # Nostrフィルタとイベントのマッチング
│   │   ├── query-manager.ts        # Reactive query管理（登録・通知・マイクロバッチング・unsubscribeクリーンアップ）
│   │   └── negative-cache.ts       # ネガティブキャッシュ（TTL付き）
│   ├── backends/
│   │   ├── interface.ts            # StorageBackendインターフェース
│   │   ├── memory.ts               # メモリバックエンド実装
│   │   └── indexeddb.ts            # IndexedDBバックエンド実装（SSRフォールバック、エラーポリシー）
│   └── sync/
│       ├── index.ts                # sync エントリポイント
│       ├── global-feed.ts          # connectStore()（reconcileDeletions統合）
│       ├── synced-query.ts         # createSyncedQuery()（REQライフサイクル、cache-aware since）
│       ├── publish.ts              # publishEvent()
│       ├── deletion-reconcile.ts   # 起動時kind:5整合性チェック
│       └── since-tracker.ts        # cache-aware since自動調整
├── tests/
│   ├── core/
│   │   ├── nip-rules.test.ts       # 16 tests
│   │   ├── filter-matcher.test.ts  #  9 tests
│   │   ├── negative-cache.test.ts  #  4 tests
│   │   ├── store.test.ts           # 24 tests
│   │   ├── store-fetch-relay.test.ts # 3 tests (tsunagiya統合)
│   │   └── query-manager.test.ts   #  2 tests
│   ├── backends/
│   │   ├── memory.test.ts          # 12 tests
│   │   ├── indexeddb.test.ts       # 11 tests
│   │   └── indexeddb-fallback.test.ts # 1 test (SSR)
│   └── sync/
│       ├── global-feed.test.ts     #  5 tests
│       ├── synced-query.test.ts    # 12 tests
│       ├── synced-query-since.test.ts # 2 tests
│       ├── publish.test.ts         #  4 tests
│       ├── deletion-reconcile.test.ts # 4 tests
│       ├── since-tracker.test.ts   #  3 tests
│       └── filter-mismatch-warn.test.ts # 1 test
└── docs/
    ├── design.md
    └── plans/
        └── 2026-03-30-auftakt-mvp.md
```

---

### Task 1: プロジェクト初期化

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/index.ts`
- Create: `src/types.ts`

- [x] **Step 1: package.json を作成**

```json
{
  "name": "@ikuradon/auftakt",
  "version": "0.0.1",
  "description": "Reactive event store for rx-nostr with NIP semantics",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./backends/memory": {
      "types": "./dist/backends/memory.d.ts",
      "import": "./dist/backends/memory.js"
    },
    "./backends/indexeddb": {
      "types": "./dist/backends/indexeddb.d.ts",
      "import": "./dist/backends/indexeddb.js"
    },
    "./sync": {
      "types": "./dist/sync/index.d.ts",
      "import": "./dist/sync/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "tsc --noEmit"
  },
  "peerDependencies": {
    "rx-nostr": "^3.0.0",
    "rxjs": "^7.8.0"
  },
  "dependencies": {
    "nostr-typedef": "^0.9.0"
  },
  "devDependencies": {
    "rx-nostr": "^3.6.0",
    "rxjs": "^7.8.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0",
    "@vitest/coverage-v8": "^1.6.0",
    "fake-indexeddb": "^6.0.0"
  },
  "license": "MIT"
}
```

- [x] **Step 2: tsconfig.json を作成**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [x] **Step 3: vitest.config.ts を作成**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/index.ts'],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
```

- [x] **Step 4: 共通型定義 src/types.ts を作成**

```typescript
import type { Nostr } from 'nostr-typedef';

/** Store に保存されたイベント + メタデータ */
export interface CachedEvent {
  event: Nostr.Event;
  seenOn: string[];
  firstSeen: number;
}

/** store.add() の結果 */
export type AddResult =
  | 'added'
  | 'replaced'
  | 'deleted'
  | 'duplicate'
  | 'expired'
  | 'ephemeral';

/** store.changes$ が emit する変更通知 */
export interface StoreChange {
  event: Nostr.Event;
  type: 'added' | 'replaced' | 'deleted';
  relay?: string;
}

/** store.add() に渡すメタデータ */
export interface EventMeta {
  relay?: string;
}

/** Nostr フィルタ（rx-nostr の LazyFilter を解決済みの具体値） */
export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [key: `#${string}`]: string[] | undefined;
}

/** SyncedQuery のステータス */
export type SyncStatus = 'cached' | 'fetching' | 'live' | 'complete';
```

- [x] **Step 5: メインエントリポイント src/index.ts を作成**

```typescript
export { createEventStore } from './core/store.js';
export type {
  CachedEvent,
  AddResult,
  StoreChange,
  EventMeta,
  NostrFilter,
  SyncStatus,
} from './types.js';
```

- [x] **Step 6: 依存関係をインストール**

Run: `cd /root/src/github.com/ikuradon/auftakt && pnpm install`
Expected: 依存関係がインストールされ `node_modules` が作成される

- [x] **Step 7: TypeScript のコンパイルチェック**

Run: `pnpm lint`
Expected: エラーなし（createEventStore が未定義のため一時的にエラーが出る場合は src/index.ts の export 行をコメントアウト）

- [x] **Step 8: git 初期化とコミット**

```bash
git init
echo 'node_modules/\ndist/\ncoverage/' > .gitignore
git add -A
git commit -m "chore: initialize project with package.json, tsconfig, vitest"
```

---

### Task 2: NIP ルールエンジン (nip-rules.ts)

**Files:**
- Create: `src/core/nip-rules.ts`
- Create: `tests/core/nip-rules.test.ts`

- [x] **Step 1: テストファイルを作成**

```typescript
// tests/core/nip-rules.test.ts
import { describe, it, expect } from 'vitest';
import {
  classifyEvent,
  isEphemeral,
  isReplaceable,
  isAddressable,
  isExpired,
  getReplaceableKey,
  getAddressableKey,
  getDTag,
  compareEventsForReplacement,
} from '../../src/core/nip-rules.js';

const makeEvent = (overrides: Partial<{ id: string; kind: number; pubkey: string; created_at: number; tags: string[][]; content: string }>): any => ({
  id: 'abc123',
  kind: 1,
  pubkey: 'pk1',
  created_at: 1000,
  tags: [],
  content: '',
  sig: 'sig1',
  ...overrides,
});

describe('classifyEvent', () => {
  it('classifies regular events', () => {
    expect(classifyEvent(makeEvent({ kind: 1 }))).toBe('regular');
    expect(classifyEvent(makeEvent({ kind: 4 }))).toBe('regular');
    expect(classifyEvent(makeEvent({ kind: 7 }))).toBe('regular');
    expect(classifyEvent(makeEvent({ kind: 1000 }))).toBe('regular');
    expect(classifyEvent(makeEvent({ kind: 9999 }))).toBe('regular');
  });

  it('classifies replaceable events', () => {
    expect(classifyEvent(makeEvent({ kind: 0 }))).toBe('replaceable');
    expect(classifyEvent(makeEvent({ kind: 3 }))).toBe('replaceable');
    expect(classifyEvent(makeEvent({ kind: 10000 }))).toBe('replaceable');
    expect(classifyEvent(makeEvent({ kind: 19999 }))).toBe('replaceable');
  });

  it('classifies ephemeral events', () => {
    expect(classifyEvent(makeEvent({ kind: 20000 }))).toBe('ephemeral');
    expect(classifyEvent(makeEvent({ kind: 29999 }))).toBe('ephemeral');
  });

  it('classifies addressable events', () => {
    expect(classifyEvent(makeEvent({ kind: 30000 }))).toBe('addressable');
    expect(classifyEvent(makeEvent({ kind: 39999 }))).toBe('addressable');
  });
});

describe('isExpired', () => {
  it('returns false when no expiration tag', () => {
    expect(isExpired(makeEvent({}))).toBe(false);
  });

  it('returns true when expiration tag is in the past', () => {
    const event = makeEvent({ tags: [['expiration', '1000']] });
    expect(isExpired(event, 2000)).toBe(true);
  });

  it('returns false when expiration tag is in the future', () => {
    const event = makeEvent({ tags: [['expiration', '3000']] });
    expect(isExpired(event, 2000)).toBe(false);
  });
});

describe('getReplaceableKey', () => {
  it('returns pubkey:kind for replaceable events', () => {
    expect(getReplaceableKey(makeEvent({ kind: 0, pubkey: 'pk1' }))).toBe('0:pk1');
  });
});

describe('getAddressableKey', () => {
  it('returns kind:pubkey:d-tag', () => {
    const event = makeEvent({ kind: 30023, pubkey: 'pk1', tags: [['d', 'hello']] });
    expect(getAddressableKey(event)).toBe('30023:pk1:hello');
  });

  it('falls back to empty string when d-tag missing', () => {
    const event = makeEvent({ kind: 30023, pubkey: 'pk1', tags: [] });
    expect(getAddressableKey(event)).toBe('30023:pk1:');
  });
});

describe('getDTag', () => {
  it('extracts d-tag value', () => {
    expect(getDTag(makeEvent({ tags: [['d', 'test']] }))).toBe('test');
  });

  it('returns empty string when no d-tag', () => {
    expect(getDTag(makeEvent({ tags: [] }))).toBe('');
  });
});

describe('compareEventsForReplacement', () => {
  it('returns positive when newEvent is newer', () => {
    const existing = makeEvent({ created_at: 1000, id: 'aaa' });
    const incoming = makeEvent({ created_at: 2000, id: 'bbb' });
    expect(compareEventsForReplacement(incoming, existing)).toBeGreaterThan(0);
  });

  it('returns negative when newEvent is older', () => {
    const existing = makeEvent({ created_at: 2000, id: 'aaa' });
    const incoming = makeEvent({ created_at: 1000, id: 'bbb' });
    expect(compareEventsForReplacement(incoming, existing)).toBeLessThan(0);
  });

  it('uses id lexicographic order for tiebreaker (lower id wins)', () => {
    const existing = makeEvent({ created_at: 1000, id: 'bbb' });
    const incoming = makeEvent({ created_at: 1000, id: 'aaa' });
    // incoming has lower id → incoming wins → positive
    expect(compareEventsForReplacement(incoming, existing)).toBeGreaterThan(0);
  });

  it('returns 0 for identical events', () => {
    const event = makeEvent({ created_at: 1000, id: 'aaa' });
    expect(compareEventsForReplacement(event, event)).toBe(0);
  });
});
```

- [x] **Step 2: テストを実行して失敗を確認**

Run: `pnpm test -- tests/core/nip-rules.test.ts`
Expected: FAIL — モジュールが見つからない

- [x] **Step 3: nip-rules.ts を実装**

```typescript
// src/core/nip-rules.ts
import type { Nostr } from 'nostr-typedef';

export type EventClassification = 'regular' | 'replaceable' | 'ephemeral' | 'addressable';

export function classifyEvent(event: Nostr.Event): EventClassification {
  const { kind } = event;
  if (kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)) return 'replaceable';
  if (kind >= 20000 && kind < 30000) return 'ephemeral';
  if (kind >= 30000 && kind < 40000) return 'addressable';
  return 'regular';
}

export function isEphemeral(event: Nostr.Event): boolean {
  return classifyEvent(event) === 'ephemeral';
}

export function isReplaceable(event: Nostr.Event): boolean {
  return classifyEvent(event) === 'replaceable';
}

export function isAddressable(event: Nostr.Event): boolean {
  return classifyEvent(event) === 'addressable';
}

export function isExpired(event: Nostr.Event, now?: number): boolean {
  const expirationTag = event.tags.find(t => t[0] === 'expiration');
  if (!expirationTag || !expirationTag[1]) return false;
  const expiresAt = parseInt(expirationTag[1], 10);
  if (isNaN(expiresAt)) return false;
  return expiresAt < (now ?? Math.floor(Date.now() / 1000));
}

export function getDTag(event: Nostr.Event): string {
  const dTag = event.tags.find(t => t[0] === 'd');
  return dTag?.[1] ?? '';
}

export function getReplaceableKey(event: Nostr.Event): string {
  return `${event.kind}:${event.pubkey}`;
}

export function getAddressableKey(event: Nostr.Event): string {
  return `${event.kind}:${event.pubkey}:${getDTag(event)}`;
}

/**
 * Compare two events for replacement.
 * Returns > 0 if incoming wins, < 0 if existing wins, 0 if identical.
 * Rule: higher created_at wins. Tiebreaker: lower id (lexicographic) wins.
 */
export function compareEventsForReplacement(
  incoming: Nostr.Event,
  existing: Nostr.Event,
): number {
  if (incoming.created_at !== existing.created_at) {
    return incoming.created_at - existing.created_at;
  }
  if (incoming.id === existing.id) return 0;
  // Lower id wins — if incoming.id < existing.id, incoming wins (return positive)
  return incoming.id < existing.id ? 1 : -1;
}
```

- [x] **Step 4: テストを実行して全パスを確認**

Run: `pnpm test -- tests/core/nip-rules.test.ts`
Expected: 全テスト PASS

- [x] **Step 5: コミット**

```bash
git add src/core/nip-rules.ts tests/core/nip-rules.test.ts
git commit -m "feat: add NIP rules engine for event classification and replacement"
```

---

### Task 3: フィルタマッチャー (filter-matcher.ts)

**Files:**
- Create: `src/core/filter-matcher.ts`
- Create: `tests/core/filter-matcher.test.ts`

- [x] **Step 1: テストファイルを作成**

```typescript
// tests/core/filter-matcher.test.ts
import { describe, it, expect } from 'vitest';
import { matchesFilter } from '../../src/core/filter-matcher.js';
import type { NostrFilter } from '../../src/types.js';

const makeEvent = (overrides: Record<string, unknown> = {}): any => ({
  id: 'event1',
  kind: 1,
  pubkey: 'pk1',
  created_at: 1000,
  tags: [],
  content: 'hello',
  sig: 'sig1',
  ...overrides,
});

describe('matchesFilter', () => {
  it('matches when filter is empty (matches all)', () => {
    expect(matchesFilter(makeEvent(), {})).toBe(true);
  });

  it('matches by ids', () => {
    expect(matchesFilter(makeEvent({ id: 'a' }), { ids: ['a', 'b'] })).toBe(true);
    expect(matchesFilter(makeEvent({ id: 'c' }), { ids: ['a', 'b'] })).toBe(false);
  });

  it('matches by kinds', () => {
    expect(matchesFilter(makeEvent({ kind: 1 }), { kinds: [1, 7] })).toBe(true);
    expect(matchesFilter(makeEvent({ kind: 3 }), { kinds: [1, 7] })).toBe(false);
  });

  it('matches by authors', () => {
    expect(matchesFilter(makeEvent({ pubkey: 'pk1' }), { authors: ['pk1'] })).toBe(true);
    expect(matchesFilter(makeEvent({ pubkey: 'pk2' }), { authors: ['pk1'] })).toBe(false);
  });

  it('matches by since', () => {
    expect(matchesFilter(makeEvent({ created_at: 1000 }), { since: 999 })).toBe(true);
    expect(matchesFilter(makeEvent({ created_at: 1000 }), { since: 1000 })).toBe(true);
    expect(matchesFilter(makeEvent({ created_at: 1000 }), { since: 1001 })).toBe(false);
  });

  it('matches by until', () => {
    expect(matchesFilter(makeEvent({ created_at: 1000 }), { until: 1001 })).toBe(true);
    expect(matchesFilter(makeEvent({ created_at: 1000 }), { until: 1000 })).toBe(true);
    expect(matchesFilter(makeEvent({ created_at: 1000 }), { until: 999 })).toBe(false);
  });

  it('matches by tag filters (#e, #p, #t)', () => {
    const event = makeEvent({ tags: [['e', 'ref1'], ['p', 'pk2'], ['t', 'nostr']] });
    expect(matchesFilter(event, { '#e': ['ref1'] })).toBe(true);
    expect(matchesFilter(event, { '#p': ['pk2'] })).toBe(true);
    expect(matchesFilter(event, { '#t': ['nostr'] })).toBe(true);
    expect(matchesFilter(event, { '#e': ['ref999'] })).toBe(false);
  });

  it('requires all filter conditions to match (AND)', () => {
    const event = makeEvent({ kind: 1, pubkey: 'pk1', created_at: 1000 });
    expect(matchesFilter(event, { kinds: [1], authors: ['pk1'] })).toBe(true);
    expect(matchesFilter(event, { kinds: [1], authors: ['pk2'] })).toBe(false);
  });

  it('ignores limit (limit is not a filter condition)', () => {
    expect(matchesFilter(makeEvent(), { limit: 10 })).toBe(true);
  });
});
```

- [x] **Step 2: テスト実行して失敗を確認**

Run: `pnpm test -- tests/core/filter-matcher.test.ts`
Expected: FAIL

- [x] **Step 3: filter-matcher.ts を実装**

```typescript
// src/core/filter-matcher.ts
import type { Nostr } from 'nostr-typedef';
import type { NostrFilter } from '../types.js';

export function matchesFilter(event: Nostr.Event, filter: NostrFilter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;

  // Tag filters: keys starting with '#'
  for (const key of Object.keys(filter)) {
    if (!key.startsWith('#')) continue;
    const tagName = key.slice(1);
    const requiredValues = filter[key as `#${string}`];
    if (!requiredValues || requiredValues.length === 0) continue;

    const eventTagValues = event.tags
      .filter(t => t[0] === tagName)
      .map(t => t[1]);

    const hasMatch = requiredValues.some(v => eventTagValues.includes(v));
    if (!hasMatch) return false;
  }

  return true;
}
```

- [x] **Step 4: テスト実行して全パスを確認**

Run: `pnpm test -- tests/core/filter-matcher.test.ts`
Expected: 全テスト PASS

- [x] **Step 5: コミット**

```bash
git add src/core/filter-matcher.ts tests/core/filter-matcher.test.ts
git commit -m "feat: add Nostr filter matcher with tag query support"
```

---

### Task 4: ストレージバックエンドインターフェース + メモリバックエンド

**Files:**
- Create: `src/backends/interface.ts`
- Create: `src/backends/memory.ts`
- Create: `tests/backends/memory.test.ts`

- [x] **Step 1: バックエンドインターフェースを作成**

```typescript
// src/backends/interface.ts
import type { Nostr } from 'nostr-typedef';
import type { NostrFilter } from '../types.js';

export interface StoredEvent {
  event: Nostr.Event;
  seenOn: string[];
  firstSeen: number;
  /** Computed tag index for multiEntry queries */
  _tag_index: string[];
  /** Computed d-tag for addressable events */
  _d_tag: string;
}

export interface StorageBackend {
  put(stored: StoredEvent): Promise<void>;
  get(eventId: string): Promise<StoredEvent | null>;
  getByReplaceableKey(kind: number, pubkey: string): Promise<StoredEvent | null>;
  getByAddressableKey(kind: number, pubkey: string, dTag: string): Promise<StoredEvent | null>;
  query(filter: NostrFilter): Promise<StoredEvent[]>;
  delete(eventId: string): Promise<void>;
  getAllEventIds(): Promise<string[]>;
  clear(): Promise<void>;
}
```

- [x] **Step 2: メモリバックエンドのテストを作成**

```typescript
// tests/backends/memory.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { memoryBackend } from '../../src/backends/memory.js';
import type { StorageBackend, StoredEvent } from '../../src/backends/interface.js';

const makeStored = (overrides: Partial<StoredEvent> = {}): StoredEvent => ({
  event: {
    id: 'e1',
    kind: 1,
    pubkey: 'pk1',
    created_at: 1000,
    tags: [],
    content: 'hello',
    sig: 'sig1',
  } as any,
  seenOn: ['wss://relay1'],
  firstSeen: Date.now(),
  _tag_index: [],
  _d_tag: '',
  ...overrides,
});

describe('memoryBackend', () => {
  let backend: StorageBackend;

  beforeEach(() => {
    backend = memoryBackend();
  });

  it('puts and gets by id', async () => {
    const stored = makeStored();
    await backend.put(stored);
    const result = await backend.get('e1');
    expect(result).toEqual(stored);
  });

  it('returns null for missing id', async () => {
    const result = await backend.get('missing');
    expect(result).toBeNull();
  });

  it('deletes by id', async () => {
    await backend.put(makeStored());
    await backend.delete('e1');
    expect(await backend.get('e1')).toBeNull();
  });

  it('queries by kinds', async () => {
    await backend.put(makeStored({ event: { ...makeStored().event, id: 'a', kind: 1 } as any }));
    await backend.put(makeStored({ event: { ...makeStored().event, id: 'b', kind: 7 } as any }));
    const results = await backend.query({ kinds: [1] });
    expect(results).toHaveLength(1);
    expect(results[0].event.id).toBe('a');
  });

  it('queries by authors', async () => {
    await backend.put(makeStored({ event: { ...makeStored().event, id: 'a', pubkey: 'pk1' } as any }));
    await backend.put(makeStored({ event: { ...makeStored().event, id: 'b', pubkey: 'pk2' } as any }));
    const results = await backend.query({ authors: ['pk2'] });
    expect(results).toHaveLength(1);
    expect(results[0].event.id).toBe('b');
  });

  it('queries with since/until', async () => {
    await backend.put(makeStored({ event: { ...makeStored().event, id: 'a', created_at: 100 } as any }));
    await backend.put(makeStored({ event: { ...makeStored().event, id: 'b', created_at: 200 } as any }));
    await backend.put(makeStored({ event: { ...makeStored().event, id: 'c', created_at: 300 } as any }));
    const results = await backend.query({ since: 150, until: 250 });
    expect(results).toHaveLength(1);
    expect(results[0].event.id).toBe('b');
  });

  it('queries by tag index', async () => {
    await backend.put(makeStored({
      event: { ...makeStored().event, id: 'a', tags: [['e', 'ref1']] } as any,
      _tag_index: ['e:ref1'],
    }));
    await backend.put(makeStored({
      event: { ...makeStored().event, id: 'b', tags: [['e', 'ref2']] } as any,
      _tag_index: ['e:ref2'],
    }));
    const results = await backend.query({ '#e': ['ref1'] });
    expect(results).toHaveLength(1);
    expect(results[0].event.id).toBe('a');
  });

  it('applies limit', async () => {
    for (let i = 0; i < 10; i++) {
      await backend.put(makeStored({
        event: { ...makeStored().event, id: `e${i}`, created_at: i * 100 } as any,
      }));
    }
    const results = await backend.query({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('getByReplaceableKey returns matching event', async () => {
    await backend.put(makeStored({
      event: { ...makeStored().event, id: 'profile1', kind: 0, pubkey: 'pk1' } as any,
    }));
    const result = await backend.getByReplaceableKey(0, 'pk1');
    expect(result?.event.id).toBe('profile1');
  });

  it('getByAddressableKey returns matching event', async () => {
    await backend.put(makeStored({
      event: { ...makeStored().event, id: 'addr1', kind: 30023, pubkey: 'pk1' } as any,
      _d_tag: 'hello',
    }));
    const result = await backend.getByAddressableKey(30023, 'pk1', 'hello');
    expect(result?.event.id).toBe('addr1');
  });

  it('getAllEventIds returns all ids', async () => {
    await backend.put(makeStored({ event: { ...makeStored().event, id: 'a' } as any }));
    await backend.put(makeStored({ event: { ...makeStored().event, id: 'b' } as any }));
    const ids = await backend.getAllEventIds();
    expect(ids.sort()).toEqual(['a', 'b']);
  });
});
```

- [x] **Step 3: テスト実行して失敗を確認**

Run: `pnpm test -- tests/backends/memory.test.ts`
Expected: FAIL

- [x] **Step 4: メモリバックエンドを実装**

```typescript
// src/backends/memory.ts
import type { NostrFilter } from '../types.js';
import type { StorageBackend, StoredEvent } from './interface.js';
import { matchesFilter } from '../core/filter-matcher.js';

export function memoryBackend(): StorageBackend {
  const byId = new Map<string, StoredEvent>();
  const byReplaceableKey = new Map<string, string>(); // "kind:pubkey" → eventId
  const byAddressableKey = new Map<string, string>(); // "kind:pubkey:dtag" → eventId

  return {
    async put(stored: StoredEvent): Promise<void> {
      const { event } = stored;
      byId.set(event.id, stored);

      // Index replaceable
      const { kind, pubkey } = event;
      if (kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)) {
        byReplaceableKey.set(`${kind}:${pubkey}`, event.id);
      }
      if (kind >= 30000 && kind < 40000) {
        byAddressableKey.set(`${kind}:${pubkey}:${stored._d_tag}`, event.id);
      }
    },

    async get(eventId: string): Promise<StoredEvent | null> {
      return byId.get(eventId) ?? null;
    },

    async getByReplaceableKey(kind: number, pubkey: string): Promise<StoredEvent | null> {
      const id = byReplaceableKey.get(`${kind}:${pubkey}`);
      return id ? (byId.get(id) ?? null) : null;
    },

    async getByAddressableKey(kind: number, pubkey: string, dTag: string): Promise<StoredEvent | null> {
      const id = byAddressableKey.get(`${kind}:${pubkey}:${dTag}`);
      return id ? (byId.get(id) ?? null) : null;
    },

    async query(filter: NostrFilter): Promise<StoredEvent[]> {
      let results: StoredEvent[] = [];

      for (const stored of byId.values()) {
        if (matchesFilter(stored.event, filter)) {
          results.push(stored);
        }
      }

      // Tag filter
      for (const key of Object.keys(filter)) {
        if (!key.startsWith('#')) continue;
        const tagName = key.slice(1);
        const values = filter[key as `#${string}`];
        if (!values || values.length === 0) continue;
        const tagKeys = values.map(v => `${tagName}:${v}`);
        results = results.filter(s =>
          s._tag_index.some(ti => tagKeys.includes(ti))
        );
      }

      // Sort by created_at descending
      results.sort((a, b) => b.event.created_at - a.event.created_at);

      // Apply limit
      if (filter.limit !== undefined && filter.limit > 0) {
        results = results.slice(0, filter.limit);
      }

      return results;
    },

    async delete(eventId: string): Promise<void> {
      const stored = byId.get(eventId);
      if (!stored) return;
      byId.delete(eventId);
      // Clean up indexes
      const { kind, pubkey } = stored.event;
      if (kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)) {
        const key = `${kind}:${pubkey}`;
        if (byReplaceableKey.get(key) === eventId) byReplaceableKey.delete(key);
      }
      if (kind >= 30000 && kind < 40000) {
        const key = `${kind}:${pubkey}:${stored._d_tag}`;
        if (byAddressableKey.get(key) === eventId) byAddressableKey.delete(key);
      }
    },

    async getAllEventIds(): Promise<string[]> {
      return Array.from(byId.keys());
    },

    async clear(): Promise<void> {
      byId.clear();
      byReplaceableKey.clear();
      byAddressableKey.clear();
    },
  };
}
```

- [x] **Step 5: テスト実行して全パスを確認**

Run: `pnpm test -- tests/backends/memory.test.ts`
Expected: 全テスト PASS

- [x] **Step 6: コミット**

```bash
git add src/backends/interface.ts src/backends/memory.ts tests/backends/memory.test.ts
git commit -m "feat: add storage backend interface and memory implementation"
```

---

### Task 5: NostrEventStore 本体 (store.ts)

これがライブラリの中核。`add()`, `query()`, `changes$` を実装する。

**Files:**
- Create: `src/core/store.ts`
- Create: `src/core/query-manager.ts`
- Create: `tests/core/store.test.ts`

- [x] **Step 1: query-manager.ts を作成**

```typescript
// src/core/query-manager.ts
import { Subject, Observable, BehaviorSubject, Subscription } from 'rxjs';
import type { NostrFilter, CachedEvent } from '../types.js';
import type { StoredEvent } from '../backends/interface.js';
import { matchesFilter } from './filter-matcher.js';
import { isExpired } from './nip-rules.js';

interface ActiveQuery {
  id: number;
  filter: NostrFilter;
  subject: BehaviorSubject<CachedEvent[]>;
  deletedIds: Set<string>;
}

export class QueryManager {
  private nextId = 0;
  private queries = new Map<number, ActiveQuery>();
  private pendingDirty = new Set<number>();
  private flushScheduled = false;

  registerQuery(
    filter: NostrFilter,
    deletedIds: Set<string>,
    initialResults: StoredEvent[],
  ): { id: number; observable: Observable<CachedEvent[]> } {
    const id = this.nextId++;
    const filtered = this.toOutput(initialResults, deletedIds);
    const subject = new BehaviorSubject<CachedEvent[]>(filtered);
    this.queries.set(id, { id, filter, subject, deletedIds });
    return { id, observable: subject.asObservable() };
  }

  unregisterQuery(queryId: number): void {
    const query = this.queries.get(queryId);
    if (query) {
      query.subject.complete();
      this.queries.delete(queryId);
      this.pendingDirty.delete(queryId);
    }
  }

  notifyChange(event: StoredEvent, deletedIds: Set<string>): void {
    for (const query of this.queries.values()) {
      if (matchesFilter(event.event, query.filter)) {
        this.pendingDirty.add(query.id);
      }
    }
    this.scheduleFlush();
  }

  notifyDeletion(eventId: string): void {
    // Mark all queries as dirty (deletion could affect any query)
    for (const query of this.queries.values()) {
      this.pendingDirty.add(query.id);
    }
    this.scheduleFlush();
  }

  /**
   * Re-evaluate dirty queries. Called with the full store query function.
   */
  flush(queryFn: (filter: NostrFilter) => Promise<StoredEvent[]>): void {
    const dirty = new Set(this.pendingDirty);
    this.pendingDirty.clear();
    this.flushScheduled = false;

    for (const queryId of dirty) {
      const query = this.queries.get(queryId);
      if (!query) continue;
      queryFn(query.filter).then(results => {
        if (!this.queries.has(queryId)) return; // disposed during async
        const filtered = this.toOutput(results, query.deletedIds);
        query.subject.next(filtered);
      });
    }
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    // Actual flush triggered by store after microtask
  }

  get hasPendingFlush(): boolean {
    return this.flushScheduled;
  }

  private toOutput(results: StoredEvent[], deletedIds: Set<string>): CachedEvent[] {
    const now = Math.floor(Date.now() / 1000);
    return results
      .filter(s => !deletedIds.has(s.event.id))
      .filter(s => !isExpired(s.event, now))
      .sort((a, b) => b.event.created_at - a.event.created_at)
      .map(s => ({
        event: s.event,
        seenOn: s.seenOn,
        firstSeen: s.firstSeen,
      }));
  }
}
```

- [x] **Step 2: store.ts のテストを作成**

```typescript
// tests/core/store.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import { firstValueFrom, take, toArray } from 'rxjs';

const makeEvent = (overrides: Record<string, unknown> = {}): any => ({
  id: 'e1',
  kind: 1,
  pubkey: 'pk1',
  created_at: 1000,
  tags: [],
  content: 'hello',
  sig: 'sig1',
  ...overrides,
});

describe('NostrEventStore', () => {
  let store: ReturnType<typeof createEventStore>;

  beforeEach(() => {
    store = createEventStore({ backend: memoryBackend() });
  });

  describe('add()', () => {
    it('adds a regular event', async () => {
      const result = await store.add(makeEvent());
      expect(result).toBe('added');
    });

    it('rejects ephemeral events', async () => {
      const result = await store.add(makeEvent({ kind: 20001 }));
      expect(result).toBe('ephemeral');
    });

    it('returns duplicate for same event id', async () => {
      await store.add(makeEvent());
      const result = await store.add(makeEvent());
      expect(result).toBe('duplicate');
    });

    it('updates seenOn on duplicate', async () => {
      await store.add(makeEvent(), { relay: 'wss://relay1' });
      await store.add(makeEvent(), { relay: 'wss://relay2' });
      // Verify via query
      const events = await firstValueFrom(store.query({ ids: ['e1'] }));
      expect(events[0].seenOn).toContain('wss://relay1');
      expect(events[0].seenOn).toContain('wss://relay2');
    });

    it('does not duplicate seenOn entries', async () => {
      await store.add(makeEvent(), { relay: 'wss://relay1' });
      await store.add(makeEvent(), { relay: 'wss://relay1' });
      const events = await firstValueFrom(store.query({ ids: ['e1'] }));
      expect(events[0].seenOn).toEqual(['wss://relay1']);
    });

    it('rejects expired events', async () => {
      const result = await store.add(makeEvent({
        tags: [['expiration', '1']],
      }));
      expect(result).toBe('expired');
    });

    it('replaces older replaceable event', async () => {
      await store.add(makeEvent({ id: 'old', kind: 0, pubkey: 'pk1', created_at: 1000 }));
      const result = await store.add(makeEvent({ id: 'new', kind: 0, pubkey: 'pk1', created_at: 2000 }));
      expect(result).toBe('replaced');
      const events = await firstValueFrom(store.query({ kinds: [0], authors: ['pk1'] }));
      expect(events).toHaveLength(1);
      expect(events[0].event.id).toBe('new');
    });

    it('discards older incoming replaceable event', async () => {
      await store.add(makeEvent({ id: 'new', kind: 0, pubkey: 'pk1', created_at: 2000 }));
      const result = await store.add(makeEvent({ id: 'old', kind: 0, pubkey: 'pk1', created_at: 1000 }));
      expect(result).toBe('duplicate');
    });

    it('handles addressable events with d-tag', async () => {
      await store.add(makeEvent({
        id: 'old', kind: 30023, pubkey: 'pk1', created_at: 1000,
        tags: [['d', 'hello']],
      }));
      const result = await store.add(makeEvent({
        id: 'new', kind: 30023, pubkey: 'pk1', created_at: 2000,
        tags: [['d', 'hello']],
      }));
      expect(result).toBe('replaced');
    });

    it('handles addressable events with empty d-tag fallback', async () => {
      await store.add(makeEvent({ id: 'a', kind: 30023, pubkey: 'pk1', created_at: 1000, tags: [] }));
      const result = await store.add(makeEvent({ id: 'b', kind: 30023, pubkey: 'pk1', created_at: 2000, tags: [] }));
      expect(result).toBe('replaced');
    });
  });

  describe('kind:5 deletion', () => {
    it('marks referenced event as deleted', async () => {
      await store.add(makeEvent({ id: 'target', kind: 1, pubkey: 'pk1' }));
      await store.add(makeEvent({
        id: 'del1', kind: 5, pubkey: 'pk1',
        tags: [['e', 'target']],
      }));
      const events = await firstValueFrom(store.query({ ids: ['target'] }));
      expect(events).toHaveLength(0);
    });

    it('rejects deletion from different pubkey', async () => {
      await store.add(makeEvent({ id: 'target', kind: 1, pubkey: 'pk1' }));
      await store.add(makeEvent({
        id: 'del1', kind: 5, pubkey: 'pk2',
        tags: [['e', 'target']],
      }));
      const events = await firstValueFrom(store.query({ ids: ['target'] }));
      expect(events).toHaveLength(1);
    });

    it('handles pendingDeletions when target arrives later', async () => {
      // Deletion arrives first
      await store.add(makeEvent({
        id: 'del1', kind: 5, pubkey: 'pk1', created_at: 2000,
        tags: [['e', 'target']],
      }));
      // Target arrives later
      await store.add(makeEvent({ id: 'target', kind: 1, pubkey: 'pk1', created_at: 1000 }));
      const events = await firstValueFrom(store.query({ ids: ['target'] }));
      expect(events).toHaveLength(0);
    });

    it('rejects already-deleted event via deletedIds check (step 1.5)', async () => {
      await store.add(makeEvent({ id: 'target', kind: 1, pubkey: 'pk1' }));
      await store.add(makeEvent({
        id: 'del1', kind: 5, pubkey: 'pk1',
        tags: [['e', 'target']],
      }));
      // Re-adding the deleted event should be rejected
      const result = await store.add(makeEvent({ id: 'target', kind: 1, pubkey: 'pk1' }));
      expect(result).toBe('deleted');
    });
  });

  describe('query()', () => {
    it('returns reactive Observable that emits on changes', async () => {
      const collected: number[] = [];
      const sub = store.query({ kinds: [1] }).subscribe(events => {
        collected.push(events.length);
      });

      // Initial emit (empty)
      await vi.waitFor(() => expect(collected).toContain(0));

      await store.add(makeEvent({ id: 'a' }));
      // Wait for microtask flush
      await vi.waitFor(() => expect(collected).toContain(1));

      await store.add(makeEvent({ id: 'b' }));
      await vi.waitFor(() => expect(collected).toContain(2));

      sub.unsubscribe();
    });
  });

  describe('changes$', () => {
    it('emits on add', async () => {
      const changes: string[] = [];
      store.changes$.subscribe(c => changes.push(c.type));
      await store.add(makeEvent());
      expect(changes).toContain('added');
    });

    it('emits replaced on replaceable update', async () => {
      const changes: string[] = [];
      store.changes$.subscribe(c => changes.push(c.type));
      await store.add(makeEvent({ id: 'old', kind: 0, created_at: 1000 }));
      await store.add(makeEvent({ id: 'new', kind: 0, created_at: 2000 }));
      expect(changes).toContain('replaced');
    });

    it('emits deleted on kind:5', async () => {
      const changes: string[] = [];
      store.changes$.subscribe(c => changes.push(c.type));
      await store.add(makeEvent({ id: 'target', kind: 1, pubkey: 'pk1' }));
      await store.add(makeEvent({
        id: 'del1', kind: 5, pubkey: 'pk1',
        tags: [['e', 'target']],
      }));
      expect(changes).toContain('deleted');
    });
  });
});
```

- [x] **Step 3: テスト実行して失敗を確認**

Run: `pnpm test -- tests/core/store.test.ts`
Expected: FAIL

- [x] **Step 4: store.ts を実装**

```typescript
// src/core/store.ts
import { Subject, Observable } from 'rxjs';
import type { Nostr } from 'nostr-typedef';
import type {
  CachedEvent,
  AddResult,
  StoreChange,
  EventMeta,
  NostrFilter,
} from '../types.js';
import type { StorageBackend, StoredEvent } from '../backends/interface.js';
import {
  classifyEvent,
  isExpired,
  getDTag,
  compareEventsForReplacement,
} from './nip-rules.js';
import { QueryManager } from './query-manager.js';

export interface EventStoreOptions {
  backend: StorageBackend;
}

export interface EventStore {
  add(event: Nostr.Event, meta?: EventMeta): Promise<AddResult>;
  query(filter: NostrFilter): Observable<CachedEvent[]>;
  changes$: Observable<StoreChange>;
}

export function createEventStore(options: EventStoreOptions): EventStore {
  const { backend } = options;
  const deletedIds = new Set<string>();
  const pendingDeletions = new Map<string, { pubkey: string; registeredAt: number }>();
  const changeSubject = new Subject<StoreChange>();
  const queryManager = new QueryManager();

  let flushScheduled = false;

  function scheduleFlush(): void {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      queryManager.flush(filter => backend.query(filter));
    });
  }

  function buildStoredEvent(event: Nostr.Event, meta?: EventMeta): StoredEvent {
    const tagIndex = event.tags
      .filter(t => t.length >= 2)
      .map(t => `${t[0]}:${t[1]}`);
    return {
      event,
      seenOn: meta?.relay ? [meta.relay] : [],
      firstSeen: Date.now(),
      _tag_index: tagIndex,
      _d_tag: getDTag(event),
    };
  }

  async function processKind5(event: Nostr.Event): Promise<void> {
    // Process e-tag deletions
    const eTargets = event.tags.filter(t => t[0] === 'e').map(t => t[1]);
    for (const targetId of eTargets) {
      const existing = await backend.get(targetId);
      if (existing) {
        if (existing.event.pubkey === event.pubkey) {
          deletedIds.add(targetId);
          changeSubject.next({ event: existing.event, type: 'deleted', relay: undefined });
          queryManager.notifyDeletion(targetId);
        }
        // pubkey mismatch → ignore
      } else {
        // Target not yet arrived → register pending
        pendingDeletions.set(targetId, { pubkey: event.pubkey, registeredAt: Date.now() });
      }
    }

    // Process a-tag deletions
    const aTargets = event.tags.filter(t => t[0] === 'a').map(t => t[1]);
    for (const aValue of aTargets) {
      const parts = aValue.split(':');
      if (parts.length < 3) continue;
      const [kindStr, pubkey, ...dTagParts] = parts;
      const kind = parseInt(kindStr, 10);
      const dTag = dTagParts.join(':');
      if (pubkey !== event.pubkey) continue;
      const existing = await backend.getByAddressableKey(kind, pubkey, dTag);
      if (existing && existing.event.created_at <= event.created_at) {
        deletedIds.add(existing.event.id);
        changeSubject.next({ event: existing.event, type: 'deleted', relay: undefined });
        queryManager.notifyDeletion(existing.event.id);
      }
    }
  }

  async function checkPendingDeletions(event: Nostr.Event): Promise<boolean> {
    const pending = pendingDeletions.get(event.id);
    if (!pending) return false;
    pendingDeletions.delete(event.id);
    if (pending.pubkey === event.pubkey) {
      deletedIds.add(event.id);
      return true;
    }
    return false;
  }

  function cleanPendingDeletions(): void {
    const threshold = Date.now() - 5 * 60 * 1000; // 5 min TTL
    const maxSize = 10000;
    for (const [id, entry] of pendingDeletions) {
      if (entry.registeredAt < threshold) pendingDeletions.delete(id);
    }
    if (pendingDeletions.size > maxSize) {
      const entries = Array.from(pendingDeletions.entries())
        .sort((a, b) => a[1].registeredAt - b[1].registeredAt);
      const toRemove = entries.slice(0, entries.length - maxSize);
      for (const [id] of toRemove) pendingDeletions.delete(id);
    }
  }

  const store: EventStore = {
    async add(event: Nostr.Event, meta?: EventMeta): Promise<AddResult> {
      // Step 1: Ephemeral
      const classification = classifyEvent(event);
      if (classification === 'ephemeral') return 'ephemeral';

      // Step 1.5: Already deleted
      if (deletedIds.has(event.id)) return 'deleted';

      // Step 2: Duplicate
      const existing = await backend.get(event.id);
      if (existing) {
        if (meta?.relay && !existing.seenOn.includes(meta.relay)) {
          existing.seenOn.push(meta.relay);
          await backend.put(existing);
        }
        return 'duplicate';
      }

      // Step 3: NIP-40 expiration
      if (isExpired(event)) return 'expired';

      // Step 4: Kind 5 deletion
      if (event.kind === 5) {
        await processKind5(event);
        // Store the deletion event itself
        await backend.put(buildStoredEvent(event, meta));
        changeSubject.next({ event, type: 'added', relay: meta?.relay });
        scheduleFlush();
        return 'added';
      }

      // Step 5: Replaceable
      if (classification === 'replaceable') {
        const existingReplaceable = await backend.getByReplaceableKey(event.kind, event.pubkey);
        if (existingReplaceable) {
          const cmp = compareEventsForReplacement(event, existingReplaceable.event);
          if (cmp <= 0) return 'duplicate'; // existing wins
          await backend.delete(existingReplaceable.event.id);
          await backend.put(buildStoredEvent(event, meta));
          changeSubject.next({ event, type: 'replaced', relay: meta?.relay });
          queryManager.notifyChange(buildStoredEvent(event, meta), deletedIds);
          scheduleFlush();
          return 'replaced';
        }
      }

      // Step 6: Addressable
      if (classification === 'addressable') {
        const dTag = getDTag(event);
        const existingAddr = await backend.getByAddressableKey(event.kind, event.pubkey, dTag);
        if (existingAddr) {
          const cmp = compareEventsForReplacement(event, existingAddr.event);
          if (cmp <= 0) return 'duplicate';
          await backend.delete(existingAddr.event.id);
          await backend.put(buildStoredEvent(event, meta));
          changeSubject.next({ event, type: 'replaced', relay: meta?.relay });
          queryManager.notifyChange(buildStoredEvent(event, meta), deletedIds);
          scheduleFlush();
          return 'replaced';
        }
      }

      // Step 7: Regular — store as-is
      const stored = buildStoredEvent(event, meta);
      await backend.put(stored);

      // Step 8: Check pending deletions
      const wasDeleted = await checkPendingDeletions(event);
      if (wasDeleted) {
        changeSubject.next({ event, type: 'deleted', relay: meta?.relay });
        queryManager.notifyDeletion(event.id);
        scheduleFlush();
        cleanPendingDeletions();
        return 'deleted';
      }

      changeSubject.next({ event, type: 'added', relay: meta?.relay });
      queryManager.notifyChange(stored, deletedIds);
      scheduleFlush();
      cleanPendingDeletions();
      return 'added';
    },

    query(filter: NostrFilter): Observable<CachedEvent[]> {
      // Get initial results synchronously-ish
      const { observable } = queryManager.registerQuery(filter, deletedIds, []);
      // Trigger initial evaluation
      backend.query(filter).then(results => {
        const initialQuery = queryManager as any;
        // Re-emit through the flush mechanism
        scheduleFlush();
      });
      // Force initial flush
      queueMicrotask(() => {
        queryManager.flush(f => backend.query(f));
      });
      return observable;
    },

    changes$: changeSubject.asObservable(),
  };

  return store;
}
```

- [x] **Step 5: テスト実行して全パスを確認**

Run: `pnpm test -- tests/core/store.test.ts`
Expected: 全テスト PASS

- [x] **Step 6: カバレッジを確認**

Run: `pnpm test:coverage`
Expected: core/ のカバレッジが 80% 以上

- [x] **Step 7: コミット**

```bash
git add src/core/store.ts src/core/query-manager.ts tests/core/store.test.ts
git commit -m "feat: implement NostrEventStore with NIP semantics and reactive queries"
```

---

### Task 6: sync — connectStore (global-feed.ts)

**Files:**
- Create: `src/sync/index.ts`
- Create: `src/sync/global-feed.ts`
- Create: `tests/sync/global-feed.test.ts`

- [x] **Step 1: テストを作成**

```typescript
// tests/sync/global-feed.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Subject } from 'rxjs';
import { connectStore } from '../../src/sync/global-feed.js';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import { firstValueFrom } from 'rxjs';

const makePacket = (overrides: Record<string, unknown> = {}): any => ({
  event: {
    id: 'e1', kind: 1, pubkey: 'pk1', created_at: 1000,
    tags: [], content: 'hello', sig: 'sig1',
    ...((overrides as any).event ?? {}),
  },
  from: 'wss://relay1',
  subId: 'sub1',
  type: 'EVENT',
  message: ['EVENT', 'sub1', {}],
  ...overrides,
});

describe('connectStore', () => {
  it('feeds events from rxNostr to store', async () => {
    const eventSubject = new Subject();
    const mockRxNostr = {
      createAllEventObservable: () => eventSubject.asObservable(),
    };
    const store = createEventStore({ backend: memoryBackend() });

    connectStore(mockRxNostr as any, store);

    eventSubject.next(makePacket());
    // Wait for fire-and-forget add
    await new Promise(r => setTimeout(r, 10));

    const events = await firstValueFrom(store.query({ ids: ['e1'] }));
    expect(events).toHaveLength(1);
    expect(events[0].seenOn).toContain('wss://relay1');
  });

  it('applies filter to exclude events', async () => {
    const eventSubject = new Subject();
    const mockRxNostr = {
      createAllEventObservable: () => eventSubject.asObservable(),
    };
    const store = createEventStore({ backend: memoryBackend() });

    connectStore(mockRxNostr as any, store, {
      filter: (event) => event.kind !== 4,
    });

    eventSubject.next(makePacket({ event: { id: 'dm1', kind: 4, pubkey: 'pk1', created_at: 1000, tags: [], content: '', sig: 's' } }));
    eventSubject.next(makePacket({ event: { id: 'note1', kind: 1, pubkey: 'pk1', created_at: 1000, tags: [], content: '', sig: 's' } }));

    await new Promise(r => setTimeout(r, 10));

    const dm = await firstValueFrom(store.query({ ids: ['dm1'] }));
    expect(dm).toHaveLength(0);
    const note = await firstValueFrom(store.query({ ids: ['note1'] }));
    expect(note).toHaveLength(1);
  });

  it('returns disconnect function', async () => {
    const eventSubject = new Subject();
    const mockRxNostr = {
      createAllEventObservable: () => eventSubject.asObservable(),
    };
    const store = createEventStore({ backend: memoryBackend() });

    const disconnect = connectStore(mockRxNostr as any, store);
    disconnect();

    eventSubject.next(makePacket({ event: { id: 'after', kind: 1, pubkey: 'pk1', created_at: 1000, tags: [], content: '', sig: 's' } }));

    await new Promise(r => setTimeout(r, 10));
    const events = await firstValueFrom(store.query({ ids: ['after'] }));
    expect(events).toHaveLength(0);
  });

  it('excludes ephemeral events by default', async () => {
    const eventSubject = new Subject();
    const mockRxNostr = {
      createAllEventObservable: () => eventSubject.asObservable(),
    };
    const store = createEventStore({ backend: memoryBackend() });

    connectStore(mockRxNostr as any, store);

    eventSubject.next(makePacket({ event: { id: 'eph1', kind: 20001, pubkey: 'pk1', created_at: 1000, tags: [], content: '', sig: 's' } }));

    await new Promise(r => setTimeout(r, 10));
    const events = await firstValueFrom(store.query({ ids: ['eph1'] }));
    expect(events).toHaveLength(0);
  });
});
```

- [x] **Step 2: テスト実行して失敗を確認**

Run: `pnpm test -- tests/sync/global-feed.test.ts`
Expected: FAIL

- [x] **Step 3: global-feed.ts を実装**

```typescript
// src/sync/global-feed.ts
import type { Nostr } from 'nostr-typedef';
import type { EventStore } from '../core/store.js';

interface ConnectStoreOptions {
  filter?: (event: Nostr.Event, meta: { relay: string }) => boolean;
  reconcileDeletions?: boolean;
}

export function connectStore(
  rxNostr: { createAllEventObservable(): import('rxjs').Observable<{ event: Nostr.Event; from: string }> },
  store: EventStore,
  options?: ConnectStoreOptions,
): () => void {
  const subscription = rxNostr.createAllEventObservable().subscribe(packet => {
    const { event, from: relay } = packet;

    if (options?.filter && !options.filter(event, { relay })) return;

    void store.add(event, { relay });
  });

  return () => subscription.unsubscribe();
}
```

- [x] **Step 4: sync/index.ts を作成**

```typescript
// src/sync/index.ts
export { connectStore } from './global-feed.js';
export { createSyncedQuery } from './synced-query.js';
export { publishEvent } from './publish.js';
```

- [x] **Step 5: synced-query.ts と publish.ts のスタブを作成**（後のタスクで実装）

```typescript
// src/sync/synced-query.ts
export function createSyncedQuery(..._args: any[]): any {
  throw new Error('Not yet implemented');
}
```

```typescript
// src/sync/publish.ts
export function publishEvent(..._args: any[]): any {
  throw new Error('Not yet implemented');
}
```

- [x] **Step 6: テスト実行して全パスを確認**

Run: `pnpm test -- tests/sync/global-feed.test.ts`
Expected: 全テスト PASS

- [x] **Step 7: コミット**

```bash
git add src/sync/ tests/sync/global-feed.test.ts
git commit -m "feat: implement connectStore for global event feed"
```

---

### Task 7: sync — createSyncedQuery (synced-query.ts)

**Files:**
- Modify: `src/sync/synced-query.ts`
- Create: `tests/sync/synced-query.test.ts`

- [x] **Step 1: テストを作成**

```typescript
// tests/sync/synced-query.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Subject, firstValueFrom } from 'rxjs';
import { take, toArray } from 'rxjs/operators';
import { createSyncedQuery } from '../../src/sync/synced-query.js';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import { connectStore } from '../../src/sync/global-feed.js';

const makeEvent = (overrides: Record<string, unknown> = {}): any => ({
  id: 'e1', kind: 1, pubkey: 'pk1', created_at: 1000,
  tags: [], content: 'hello', sig: 'sig1',
  ...overrides,
});

function createMockRxNostr() {
  const allEvents$ = new Subject<any>();
  const useResults = new Map<string, Subject<any>>();

  return {
    allEvents$,
    useResults,
    createAllEventObservable: () => allEvents$.asObservable(),
    use: vi.fn((rxReq: any, _options?: any) => {
      const sub = new Subject<any>();
      // Store for later emission
      const key = Math.random().toString();
      useResults.set(key, sub);
      return sub.asObservable();
    }),
  };
}

describe('createSyncedQuery', () => {
  it('returns events$ and status$', () => {
    const store = createEventStore({ backend: memoryBackend() });
    const mockRxNostr = createMockRxNostr();

    const { events$, status$, dispose } = createSyncedQuery(
      mockRxNostr as any,
      store,
      { filter: { kinds: [1] }, strategy: 'backward' },
    );

    expect(events$).toBeDefined();
    expect(status$).toBeDefined();
    dispose();
  });

  it('emits cached events immediately', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add(makeEvent({ id: 'cached1', kind: 1 }));

    const mockRxNostr = createMockRxNostr();

    const { events$, dispose } = createSyncedQuery(
      mockRxNostr as any,
      store,
      { filter: { kinds: [1] }, strategy: 'backward' },
    );

    const first = await firstValueFrom(events$);
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(first[0].event.id).toBe('cached1');
    dispose();
  });

  it('dispose completes events$ and status$', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const mockRxNostr = createMockRxNostr();

    const { events$, status$, dispose } = createSyncedQuery(
      mockRxNostr as any,
      store,
      { filter: { kinds: [1] }, strategy: 'backward' },
    );

    let eventsCompleted = false;
    let statusCompleted = false;
    events$.subscribe({ complete: () => { eventsCompleted = true; } });
    status$.subscribe({ complete: () => { statusCompleted = true; } });

    dispose();

    expect(eventsCompleted).toBe(true);
    expect(statusCompleted).toBe(true);
  });

  it('emit() after dispose() is no-op', () => {
    const store = createEventStore({ backend: memoryBackend() });
    const mockRxNostr = createMockRxNostr();

    const { emit, dispose } = createSyncedQuery(
      mockRxNostr as any,
      store,
      { filter: { kinds: [1] }, strategy: 'backward' },
    );

    dispose();
    // Should not throw
    expect(() => emit({ kinds: [7] })).not.toThrow();
  });
});
```

- [x] **Step 2: テスト実行して失敗を確認**

Run: `pnpm test -- tests/sync/synced-query.test.ts`
Expected: FAIL（スタブがthrow）

- [x] **Step 3: synced-query.ts を実装**

```typescript
// src/sync/synced-query.ts
import { BehaviorSubject, Observable, Subscription } from 'rxjs';
import type { Nostr } from 'nostr-typedef';
import type { CachedEvent, NostrFilter, SyncStatus } from '../types.js';
import type { EventStore } from '../core/store.js';

interface SyncedQueryOptions {
  filter: NostrFilter;
  strategy: 'backward' | 'forward' | 'dual';
  on?: { relays?: string[] };
  staleTime?: number;
}

interface SyncedQueryResult {
  events$: Observable<CachedEvent[]>;
  status$: Observable<SyncStatus>;
  emit: (filter: NostrFilter) => void;
  dispose: () => void;
}

export function createSyncedQuery(
  rxNostr: any,
  store: EventStore,
  options: SyncedQueryOptions,
): SyncedQueryResult {
  const statusSubject = new BehaviorSubject<SyncStatus>('cached');
  let currentFilter = options.filter;
  let disposed = false;
  let querySubscription: Subscription | null = null;
  let eventsSubject = new BehaviorSubject<CachedEvent[]>([]);

  function setupQuery(filter: NostrFilter): void {
    // Unsubscribe previous query
    querySubscription?.unsubscribe();

    // Subscribe to store.query()
    querySubscription = store.query(filter).subscribe(events => {
      if (!disposed) {
        eventsSubject.next(events);
      }
    });
  }

  // Initial setup
  setupQuery(currentFilter);

  // Start REQ based on strategy (simplified for MVP — full rx-nostr integration in sync layer)
  // The actual REQ management relies on connectStore() feeding events into the store.
  // SyncedQuery's primary role in MVP is: store.query() reactive wrapper + status management.
  if (options.strategy !== 'forward') {
    statusSubject.next('fetching');
    // In MVP, transition to complete/live after a delay or when connectStore feeds events.
    // Full backward REQ management is deferred to integration with actual rx-nostr.
  }
  if (options.strategy === 'forward' || options.strategy === 'dual') {
    statusSubject.next(options.strategy === 'dual' ? 'fetching' : 'live');
  }

  return {
    events$: eventsSubject.asObservable(),
    status$: statusSubject.asObservable(),

    emit(filter: NostrFilter): void {
      if (disposed) return;
      currentFilter = filter;
      setupQuery(filter);
      if (options.strategy !== 'forward') {
        statusSubject.next('fetching');
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      querySubscription?.unsubscribe();
      eventsSubject.complete();
      statusSubject.complete();
    },
  };
}
```

- [x] **Step 4: テスト実行して全パスを確認**

Run: `pnpm test -- tests/sync/synced-query.test.ts`
Expected: 全テスト PASS

- [x] **Step 5: コミット**

```bash
git add src/sync/synced-query.ts tests/sync/synced-query.test.ts
git commit -m "feat: implement createSyncedQuery with reactive store queries and lifecycle"
```

---

### Task 8: sync — publishEvent (publish.ts)

**Files:**
- Modify: `src/sync/publish.ts`
- Create: `tests/sync/publish.test.ts`

- [x] **Step 1: テストを作成**

```typescript
// tests/sync/publish.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Subject, firstValueFrom } from 'rxjs';
import { publishEvent } from '../../src/sync/publish.js';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';

describe('publishEvent', () => {
  it('calls rxNostr.send and returns ok$', () => {
    const okSubject = new Subject<any>();
    const mockRxNostr = {
      send: vi.fn(() => okSubject.asObservable()),
    };
    const store = createEventStore({ backend: memoryBackend() });
    const params = { kind: 1, content: 'hello', tags: [], created_at: 1000 };

    const ok$ = publishEvent(mockRxNostr as any, store, params, {
      signer: {} as any,
    });

    expect(ok$).toBeDefined();
    expect(mockRxNostr.send).toHaveBeenCalled();
  });

  it('adds event to store when optimistic: true', async () => {
    const okSubject = new Subject<any>();
    const signedEvent = {
      id: 'signed1', kind: 1, pubkey: 'pk1', created_at: 1000,
      tags: [], content: 'hello', sig: 'sig1',
    };
    const mockRxNostr = {
      send: vi.fn((_params: any, _opts: any) => {
        // simulate signed event available
        return okSubject.asObservable();
      }),
    };
    const store = createEventStore({ backend: memoryBackend() });

    publishEvent(mockRxNostr as any, store, signedEvent as any, {
      optimistic: true,
    });

    // Wait for add
    await new Promise(r => setTimeout(r, 10));
    const events = await firstValueFrom(store.query({ ids: ['signed1'] }));
    expect(events).toHaveLength(1);
  });
});
```

- [x] **Step 2: テスト実行して失敗を確認**

Run: `pnpm test -- tests/sync/publish.test.ts`
Expected: FAIL

- [x] **Step 3: publish.ts を実装**

```typescript
// src/sync/publish.ts
import type { Observable } from 'rxjs';
import type { Nostr } from 'nostr-typedef';
import type { EventStore } from '../core/store.js';

interface PublishOptions {
  signer?: any;
  optimistic?: boolean;
  on?: { relays?: string[] };
}

export function publishEvent(
  rxNostr: { send(params: any, options?: any): Observable<any> },
  store: EventStore,
  eventParams: any,
  options?: PublishOptions,
): Observable<any> {
  // If optimistic and event has id+sig (pre-signed), add to store immediately
  if (options?.optimistic && eventParams.id && eventParams.sig) {
    void store.add(eventParams as Nostr.Event);
  }

  const sendOptions: Record<string, unknown> = {};
  if (options?.signer) sendOptions.signer = options.signer;
  if (options?.on) sendOptions.on = options.on;

  return rxNostr.send(eventParams, sendOptions);
}
```

- [x] **Step 4: テスト実行して全パスを確認**

Run: `pnpm test -- tests/sync/publish.test.ts`
Expected: 全テスト PASS

- [x] **Step 5: コミット**

```bash
git add src/sync/publish.ts tests/sync/publish.test.ts
git commit -m "feat: implement publishEvent with optimistic store update"
```

---

### Task 9: IndexedDB バックエンド

**Files:**
- Create: `src/backends/indexeddb.ts`
- Create: `tests/backends/indexeddb.test.ts`

- [x] **Step 1: テストを作成（fake-indexeddb 使用）**

```typescript
// tests/backends/indexeddb.test.ts
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { indexedDBBackend } from '../../src/backends/indexeddb.js';
import type { StorageBackend, StoredEvent } from '../../src/backends/interface.js';

const makeStored = (overrides: Partial<StoredEvent> = {}): StoredEvent => ({
  event: {
    id: 'e1', kind: 1, pubkey: 'pk1', created_at: 1000,
    tags: [], content: 'hello', sig: 'sig1',
  } as any,
  seenOn: ['wss://relay1'],
  firstSeen: Date.now(),
  _tag_index: [],
  _d_tag: '',
  ...overrides,
});

describe('indexedDBBackend', () => {
  let backend: StorageBackend;
  let dbCounter = 0;

  beforeEach(async () => {
    backend = indexedDBBackend(`test-db-${dbCounter++}`);
  });

  it('puts and gets by id', async () => {
    const stored = makeStored();
    await backend.put(stored);
    const result = await backend.get('e1');
    expect(result?.event.id).toBe('e1');
  });

  it('returns null for missing id', async () => {
    const result = await backend.get('missing');
    expect(result).toBeNull();
  });

  it('deletes by id', async () => {
    await backend.put(makeStored());
    await backend.delete('e1');
    expect(await backend.get('e1')).toBeNull();
  });

  it('queries by kinds', async () => {
    await backend.put(makeStored({ event: { ...makeStored().event, id: 'a', kind: 1 } as any }));
    await backend.put(makeStored({ event: { ...makeStored().event, id: 'b', kind: 7 } as any }));
    const results = await backend.query({ kinds: [1] });
    expect(results).toHaveLength(1);
    expect(results[0].event.id).toBe('a');
  });

  it('queries by tag index', async () => {
    await backend.put(makeStored({
      event: { ...makeStored().event, id: 'a', tags: [['e', 'ref1']] } as any,
      _tag_index: ['e:ref1'],
    }));
    const results = await backend.query({ '#e': ['ref1'] });
    expect(results).toHaveLength(1);
  });

  it('getByReplaceableKey works', async () => {
    await backend.put(makeStored({
      event: { ...makeStored().event, id: 'p1', kind: 0, pubkey: 'pk1' } as any,
    }));
    const result = await backend.getByReplaceableKey(0, 'pk1');
    expect(result?.event.id).toBe('p1');
  });

  it('getByAddressableKey works', async () => {
    await backend.put(makeStored({
      event: { ...makeStored().event, id: 'a1', kind: 30023, pubkey: 'pk1' } as any,
      _d_tag: 'hello',
    }));
    const result = await backend.getByAddressableKey(30023, 'pk1', 'hello');
    expect(result?.event.id).toBe('a1');
  });
});
```

- [x] **Step 2: テスト実行して失敗を確認**

Run: `pnpm test -- tests/backends/indexeddb.test.ts`
Expected: FAIL

- [x] **Step 3: indexeddb.ts を実装**

```typescript
// src/backends/indexeddb.ts
import type { NostrFilter } from '../types.js';
import type { StorageBackend, StoredEvent } from './interface.js';
import { matchesFilter } from '../core/filter-matcher.js';

const DB_VERSION = 1;

function openDB(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('events')) {
        const store = db.createObjectStore('events', { keyPath: 'event.id' });
        store.createIndex('pubkey_kind', ['event.pubkey', 'event.kind']);
        store.createIndex('replace_key', ['event.kind', 'event.pubkey', '_d_tag']);
        store.createIndex('kind_created_at', ['event.kind', 'event.created_at']);
        store.createIndex('tag_index', '_tag_index', { multiEntry: true });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function indexedDBBackend(dbName: string): StorageBackend {
  let dbPromise: Promise<IDBDatabase> | null = null;

  function getDB(): Promise<IDBDatabase> {
    if (!dbPromise) {
      if (typeof indexedDB === 'undefined') {
        throw new Error('IndexedDB not available');
      }
      dbPromise = openDB(dbName);
    }
    return dbPromise;
  }

  function tx(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest | void,
  ): Promise<any> {
    return getDB().then(db => new Promise((resolve, reject) => {
      const transaction = db.transaction('events', mode);
      const store = transaction.objectStore('events');
      const result = fn(store);
      if (result) {
        result.onsuccess = () => resolve(result.result);
        result.onerror = () => reject(result.error);
      } else {
        transaction.oncomplete = () => resolve(undefined);
        transaction.onerror = () => reject(transaction.error);
      }
    }));
  }

  return {
    async put(stored: StoredEvent): Promise<void> {
      await tx('readwrite', store => store.put(stored));
    },

    async get(eventId: string): Promise<StoredEvent | null> {
      const result = await tx('readonly', store => store.get(eventId));
      return result ?? null;
    },

    async getByReplaceableKey(kind: number, pubkey: string): Promise<StoredEvent | null> {
      const db = await getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('events', 'readonly');
        const store = transaction.objectStore('events');
        const index = store.index('pubkey_kind');
        const request = index.get([pubkey, kind]);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
    },

    async getByAddressableKey(kind: number, pubkey: string, dTag: string): Promise<StoredEvent | null> {
      const db = await getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('events', 'readonly');
        const store = transaction.objectStore('events');
        const index = store.index('replace_key');
        const request = index.get([kind, pubkey, dTag]);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
    },

    async query(filter: NostrFilter): Promise<StoredEvent[]> {
      const db = await getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('events', 'readonly');
        const store = transaction.objectStore('events');

        // For tag queries, use tag_index
        const tagKeys = Object.keys(filter).filter(k => k.startsWith('#'));
        if (tagKeys.length > 0) {
          const tagName = tagKeys[0].slice(1);
          const values = filter[tagKeys[0] as `#${string}`] ?? [];
          if (values.length > 0) {
            const index = store.index('tag_index');
            const request = index.getAll(`${tagName}:${values[0]}`);
            request.onsuccess = () => {
              let results: StoredEvent[] = request.result;
              results = results.filter(s => matchesFilter(s.event, filter));
              results.sort((a, b) => b.event.created_at - a.event.created_at);
              if (filter.limit) results = results.slice(0, filter.limit);
              resolve(results);
            };
            request.onerror = () => reject(request.error);
            return;
          }
        }

        // For kind queries, use kind_created_at index
        if (filter.kinds && filter.kinds.length === 1) {
          const index = store.index('kind_created_at');
          const kind = filter.kinds[0];
          const range = IDBKeyRange.bound([kind, 0], [kind, Infinity]);
          const request = index.getAll(range);
          request.onsuccess = () => {
            let results: StoredEvent[] = request.result;
            results = results.filter(s => matchesFilter(s.event, filter));
            results.sort((a, b) => b.event.created_at - a.event.created_at);
            if (filter.limit) results = results.slice(0, filter.limit);
            resolve(results);
          };
          request.onerror = () => reject(request.error);
          return;
        }

        // Fallback: full scan
        const request = store.getAll();
        request.onsuccess = () => {
          let results: StoredEvent[] = request.result;
          results = results.filter(s => matchesFilter(s.event, filter));
          results.sort((a, b) => b.event.created_at - a.event.created_at);
          if (filter.limit) results = results.slice(0, filter.limit);
          resolve(results);
        };
        request.onerror = () => reject(request.error);
      });
    },

    async delete(eventId: string): Promise<void> {
      await tx('readwrite', store => store.delete(eventId));
    },

    async getAllEventIds(): Promise<string[]> {
      const db = await getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('events', 'readonly');
        const store = transaction.objectStore('events');
        const request = store.getAllKeys();
        request.onsuccess = () => resolve(request.result as string[]);
        request.onerror = () => reject(request.error);
      });
    },

    async clear(): Promise<void> {
      await tx('readwrite', store => store.clear());
    },
  };
}
```

- [x] **Step 4: テスト実行して全パスを確認**

Run: `pnpm test -- tests/backends/indexeddb.test.ts`
Expected: 全テスト PASS

- [x] **Step 5: コミット**

```bash
git add src/backends/indexeddb.ts tests/backends/indexeddb.test.ts
git commit -m "feat: implement IndexedDB storage backend with compound indexes"
```

---

### Task 10: 統合テスト + カバレッジ検証 + エクスポート整理

**Files:**
- Modify: `src/index.ts`
- Modify: `src/sync/index.ts`

- [x] **Step 1: src/index.ts のエクスポートを整理**

```typescript
// src/index.ts
export { createEventStore } from './core/store.js';
export type { EventStore, EventStoreOptions } from './core/store.js';
export type {
  CachedEvent,
  AddResult,
  StoreChange,
  EventMeta,
  NostrFilter,
  SyncStatus,
} from './types.js';
```

- [x] **Step 2: 全テスト + カバレッジを実行**

Run: `pnpm test:coverage`
Expected: 全テスト PASS、src/ のカバレッジ 80% 以上

- [x] **Step 3: TypeScript ビルドを確認**

Run: `pnpm build`
Expected: `dist/` にJSファイルと型定義が生成される

- [x] **Step 4: コミット**

```bash
git add -A
git commit -m "feat: finalize MVP exports and verify coverage"
```

---

---

## 追加タスク（spec突合せで発見・実装）

計画策定後のspecレビューで欠落が判明し、TDDで追加実装したタスク。

### Task 11: ネガティブキャッシュ ✅

- [x] テスト作成（4 tests）
- [x] `src/core/negative-cache.ts` 実装
- [x] コミット: `d9bc6b7`

### Task 12: createSyncedQuery rxNostr REQライフサイクル書き直し ✅

spec C1/C2: SyncedQueryがrxNostrを受け取り、backward/forward REQを管理する。

- [x] テスト書き直し（12 tests）— rxNostr mock、strategy遷移、on option
- [x] `src/sync/synced-query.ts` 全面書き直し — RxReq作成、EOSE検知、staleTime
- [x] コミット: `2e65845`

### Task 13: deletion-reconcile.ts ✅

spec I1/I6: connectStoreの`reconcileDeletions`オプション + 起動時kind:5整合性チェック。

- [x] テスト作成（4 tests）— チャンク分割、空ID、削除適用
- [x] `src/sync/deletion-reconcile.ts` 実装
- [x] `src/sync/global-feed.ts` にreconcileDeletions統合
- [x] コミット: `b427ef7`

### Task 14: IndexedDB SSRフォールバック + エラーポリシー ✅

spec I8/I9: SSR環境でメモリフォールバック、IDB書き込み失敗時にthrowしない。

- [x] SSRフォールバックテスト（1 test）
- [x] `src/backends/indexeddb.ts` 修正 — `typeof indexedDB === 'undefined'` チェック、put() try-catch
- [x] コミット: `e9f7cfc`

### Task 15: since-tracker.ts ✅

spec I7: cache-aware since自動調整。

- [x] テスト作成（3 tests）
- [x] `src/sync/since-tracker.ts` 実装
- [x] コミット: `f73c9c7`

### Task 16: fetchById リレーfetch (tsunagiya統合テスト) ✅

spec I5: fetchByIdがリレーからイベントを取得。

- [x] tsunagiyaを使った統合テスト（3 tests）
- [x] `src/core/store.ts` fetchById拡張 — fetch option、fetchFromRelay内部関数
- [x] コミット: `2ff4716`

### Task 17: query unsubscribeクリーンアップ ✅

spec §4.3: unsubscribe時にQueryManagerからクエリ登録を除去（メモリリーク防止）。

- [x] テスト作成（2 tests）
- [x] `src/core/store.ts` query() — Observable wrapper with teardown
- [x] コミット: `8cefde0`

### Task 18: SyncedQuery cache-aware since統合 ✅

spec §4.4: backward REQのフィルタにキャッシュ最新のcreated_atをsince設定。

- [x] テスト作成（2 tests）
- [x] `src/sync/synced-query.ts` — sinceTracker統合、startBackward非同期化
- [x] コミット: `8a34ff6`

---

## 最終結果

| 指標 | 値 |
|------|------|
| テスト数 | 113 |
| テストファイル数 | 16 |
| テスト結果 | 全PASS |
| Coverage (statements) | 92% |
| Coverage (branches) | 89% |
| Coverage (functions) | 89% |
| TypeScript | clean |
| Build | clean |
| コミット数 | 18 |

## Spec Coverage (最終)

| Spec セクション | タスク | 状態 |
|---------------|--------|:---:|
| §4.1 Store作成 | Task 5 | ✅ |
| §4.2 connectStore | Task 6, 13 | ✅ |
| §4.3 store.query() | Task 5, 17 | ✅ |
| §4.3.1 store.changes$ | Task 5 | ✅ |
| §4.4 createSyncedQuery | Task 12, 18 | ✅ |
| §4.5 publishEvent | Task 8 | ✅ |
| §4.6 fetchById | Task 5, 11, 16 | ✅ |
| §5.1 store.add() ロジック | Task 5 | ✅ |
| §5.2 削除済みイベント | Task 5, 13 | ✅ |
| §5.3 セキュリティモデル | 設計準拠（再検証しない） | ✅ |
| §5.4 クエリフィルタリング | Task 5 | ✅ |
| §6.1 IndexedDB | Task 9, 14 | ✅ |
| §6.2 メモリバックエンド | Task 4 | ✅ |
| §7.1 マイクロバッチング | Task 5 | ✅ |
| §8 CachedEvent型 | Task 1 | ✅ |
| §3 since-tracker | Task 15, 18 | ✅ |
| §3 deletion-reconcile | Task 13 | ✅ |
| §3 negative-cache | Task 11 | ✅ |

### 未カバー（v2以降）

- §7.2 クエリ逆引きインデックス（v2最適化）
- §9 v2/v3 最適化全般
- adapters/svelte.ts（§13未解決事項）
- §3 Gotcha console.warn（デバッグモード、テストのみ記録）
- §6.1 2フェーズバッチ書き込み（最適化）
- §6.1 metadata/deleted/negative_cache ObjectStore分離（機能的に不要）
