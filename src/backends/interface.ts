import type { NostrEvent, NostrFilter } from '../types.js';

export interface StoredEvent {
  event: NostrEvent;
  seenOn: string[];
  firstSeen: number;
  _tag_index: string[];
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
  /** Mark an event as deleted (persists in IDB, no-op in memory) */
  markDeleted?(eventId: string, deletionEventId: string): Promise<void>;
  /** Check if an event is marked as deleted */
  isDeleted?(eventId: string): Promise<boolean>;
  /** Set a negative cache entry with expiration timestamp */
  setNegative?(eventId: string, expiresAt: number): Promise<void>;
  /** Check if a negative cache entry exists and is not expired */
  isNegative?(eventId: string): Promise<boolean>;
}
