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
}
