import type { Event } from 'nostr-typedef';

/** Nostr イベント型（nostr-typedef から re-export） */
export type NostrEvent = Event;

/** Store に保存されたイベント + メタデータ */
export interface CachedEvent {
  event: NostrEvent;
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
  | 'ephemeral'
  | 'rejected';

/** store.changes$ が emit する変更通知 */
export interface StoreChange {
  event: NostrEvent;
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
