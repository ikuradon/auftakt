import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createNegativeCache } from '../../src/core/negative-cache.js';

describe('NegativeCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('returns false for unknown id', () => {
    const cache = createNegativeCache();
    expect(cache.has('unknown')).toBe(false);
  });

  it('returns true for registered id within TTL', () => {
    const cache = createNegativeCache();
    cache.set('id1', 30_000);
    expect(cache.has('id1')).toBe(true);
  });

  it('returns false after TTL expires', () => {
    const cache = createNegativeCache();
    cache.set('id1', 30_000);
    vi.advanceTimersByTime(31_000);
    expect(cache.has('id1')).toBe(false);
  });

  it('can be invalidated manually', () => {
    const cache = createNegativeCache();
    cache.set('id1', 30_000);
    cache.delete('id1');
    expect(cache.has('id1')).toBe(false);
  });
});
