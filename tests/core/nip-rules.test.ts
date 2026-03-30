import { describe, it, expect } from 'vitest';
import {
  classifyEvent,
  isExpired,
  getReplaceableKey,
  getAddressableKey,
  getDTag,
  compareEventsForReplacement,
} from '../../src/core/nip-rules.js';
import type { NostrEvent } from '../../src/types.js';

const makeEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
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
  it('returns kind:pubkey for replaceable events', () => {
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
  it('returns positive when incoming is newer', () => {
    const existing = makeEvent({ created_at: 1000, id: 'aaa' });
    const incoming = makeEvent({ created_at: 2000, id: 'bbb' });
    expect(compareEventsForReplacement(incoming, existing)).toBeGreaterThan(0);
  });

  it('returns negative when incoming is older', () => {
    const existing = makeEvent({ created_at: 2000, id: 'aaa' });
    const incoming = makeEvent({ created_at: 1000, id: 'bbb' });
    expect(compareEventsForReplacement(incoming, existing)).toBeLessThan(0);
  });

  it('uses id lexicographic order for tiebreaker (lower id wins)', () => {
    const existing = makeEvent({ created_at: 1000, id: 'bbb' });
    const incoming = makeEvent({ created_at: 1000, id: 'aaa' });
    expect(compareEventsForReplacement(incoming, existing)).toBeGreaterThan(0);
  });

  it('returns 0 for identical events', () => {
    const event = makeEvent({ created_at: 1000, id: 'aaa' });
    expect(compareEventsForReplacement(event, event)).toBe(0);
  });
});
