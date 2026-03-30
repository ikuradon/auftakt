import type { NostrEvent } from '../types.js';

export type EventClassification = 'regular' | 'replaceable' | 'ephemeral' | 'addressable';

export function classifyEvent(event: NostrEvent): EventClassification {
  const { kind } = event;
  if (kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)) return 'replaceable';
  if (kind >= 20000 && kind < 30000) return 'ephemeral';
  if (kind >= 30000 && kind < 40000) return 'addressable';
  return 'regular';
}

export function isExpired(event: NostrEvent, now?: number): boolean {
  const expirationTag = event.tags.find((t) => t[0] === 'expiration');
  if (!expirationTag || !expirationTag[1]) return false;
  const expiresAt = parseInt(expirationTag[1], 10);
  if (isNaN(expiresAt)) return false;
  return expiresAt < (now ?? Math.floor(Date.now() / 1000));
}

export function getDTag(event: NostrEvent): string {
  const dTag = event.tags.find((t) => t[0] === 'd');
  return dTag?.[1] ?? '';
}

export function getReplaceableKey(event: NostrEvent): string {
  return `${event.kind}:${event.pubkey}`;
}

export function getAddressableKey(event: NostrEvent): string {
  return `${event.kind}:${event.pubkey}:${getDTag(event)}`;
}

/**
 * Compare two events for replacement.
 * Returns > 0 if incoming wins, < 0 if existing wins, 0 if identical.
 * Rule: higher created_at wins. Tiebreaker: lower id (lexicographic) wins.
 */
export function compareEventsForReplacement(incoming: NostrEvent, existing: NostrEvent): number {
  if (incoming.created_at !== existing.created_at) {
    return incoming.created_at - existing.created_at;
  }
  if (incoming.id === existing.id) return 0;
  return incoming.id < existing.id ? 1 : -1;
}
