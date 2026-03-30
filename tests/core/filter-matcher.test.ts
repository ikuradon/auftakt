import { describe, it, expect } from 'vitest';
import { matchesFilter } from '../../src/core/filter-matcher.js';
import type { NostrEvent, NostrFilter } from '../../src/types.js';

const makeEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
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
    const event = makeEvent({
      tags: [
        ['e', 'ref1'],
        ['p', 'pk2'],
        ['t', 'nostr'],
      ],
    });
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

  it('matches ids by prefix (NIP-01)', () => {
    const event = makeEvent({
      id: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    });
    expect(matchesFilter(event, { ids: ['abcdef'] })).toBe(true);
    expect(matchesFilter(event, { ids: ['abcdef1234567890'] })).toBe(true);
    expect(matchesFilter(event, { ids: ['xxxxxx'] })).toBe(false);
  });

  it('matches authors by prefix (NIP-01)', () => {
    const event = makeEvent({
      pubkey: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    });
    expect(matchesFilter(event, { authors: ['abcdef'] })).toBe(true);
    expect(matchesFilter(event, { authors: ['xyz'] })).toBe(false);
  });

  it('still matches ids by exact match', () => {
    expect(matchesFilter(makeEvent({ id: 'abc' }), { ids: ['abc'] })).toBe(true);
    expect(matchesFilter(makeEvent({ id: 'abc' }), { ids: ['ab'] })).toBe(true);
    expect(matchesFilter(makeEvent({ id: 'abc' }), { ids: ['abcd'] })).toBe(false);
  });
});
