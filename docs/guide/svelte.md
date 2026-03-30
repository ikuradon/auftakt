# Svelte 連携

auftakt は Svelte の `readable` ストアアダプターを提供しています。

## インポート

```typescript
import { createSvelteQuery, toReadable } from '@ikuradon/auftakt/adapters/svelte';
```

## createSvelteQuery

`createSyncedQuery` + Svelte readable を一体化したヘルパー:

```typescript
const { events, status, emit, dispose } = createSvelteQuery(rxNostr, store, {
  filter: { kinds: [1], authors: followList },
  strategy: 'dual',
});
```

| 戻り値 | 型 | 説明 |
|--------|-----|------|
| `events` | `Readable<CachedEvent[]>` | リアクティブなイベントリスト |
| `status` | `Readable<SyncStatus>` | 同期ステータス |
| `emit` | `(filter) => void` | フィルタ変更 |
| `dispose` | `() => void` | クリーンアップ |

### Svelte コンポーネントでの使用

```svelte
<script>
  import { createSvelteQuery } from '@ikuradon/auftakt/adapters/svelte';
  import { onDestroy } from 'svelte';

  const { events, status, dispose } = createSvelteQuery(rxNostr, store, {
    filter: { kinds: [1], limit: 50 },
    strategy: 'dual',
  });

  onDestroy(dispose);
</script>

{#if $status === 'fetching'}
  <p>読み込み中...</p>
{/if}

{#each $events as cached}
  <p>{cached.event.content}</p>
{/each}
```

## toReadable

既存の `Observable` を Svelte readable に変換するユーティリティ:

```typescript
import { toReadable } from '@ikuradon/auftakt/adapters/svelte';

const events$ = store.query({ kinds: [0], authors: [pubkey] });
const events = toReadable(events$, []);
```

`toReadable(observable, initialValue)` は `Readable<T>` を返します。
