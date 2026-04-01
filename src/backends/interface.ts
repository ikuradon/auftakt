import type { NostrEvent, NostrFilter } from '../types.js';

export interface StoredEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  event: NostrEvent;
  seenOn: string[];
  firstSeen: number;
  _tag_index: string[];
  _d_tag: string;
}

export interface DeletedRecord {
  eventId: string;
  deletedBy: string;
  deletedAt: number;
}

export interface ReplaceDeletionRecord {
  aTagHash: string;
  deletedAt: number;
  deletedBy: string;
}

export interface StorageBackend {
  put(stored: StoredEvent): Promise<void>;
  get(eventId: string): Promise<StoredEvent | null>;
  getByReplaceableKey(kind: number, pubkey: string): Promise<StoredEvent | null>;
  getByAddressableKey(kind: number, pubkey: string, dTag: string): Promise<StoredEvent | null>;
  query(filter: NostrFilter): Promise<StoredEvent[]>;
  count(filter: NostrFilter): Promise<number>;
  delete(eventId: string): Promise<void>;
  getAllEventIds(): Promise<string[]>;
  clear(): Promise<void>;
  markDeleted(eventId: string, deletedBy: string, deletedAt: number): Promise<void>;
  isDeleted(eventId: string, pubkey?: string): Promise<boolean>;
  markReplaceDeletion(aTagHash: string, deletedBy: string, deletedAt: number): Promise<void>;
  getReplaceDeletion(aTagHash: string): Promise<ReplaceDeletionRecord | null>;
  setNegative(eventId: string, ttl: number): Promise<void>;
  isNegative(eventId: string): Promise<boolean>;
  cleanExpiredNegative(): Promise<void>;
  dispose?(): Promise<void>;
}
