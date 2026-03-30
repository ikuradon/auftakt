import { describe, it, expect, beforeEach } from 'vitest';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import type { NostrEvent } from '../../src/types.js';

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const makeEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
  id: 'e1',
  kind: 1,
  pubkey: 'pk1',
  created_at: 1000,
  tags: [],
  content: '',
  sig: 'sig1',
  ...overrides,
});

describe('query unsubscribe cleanup', () => {
  it('stops receiving updates after unsubscribe', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const collected: number[] = [];

    const sub = store.query({ kinds: [1] }).subscribe((events) => {
      collected.push(events.length);
    });

    await wait();
    await store.add(makeEvent({ id: 'a' }));
    await wait();

    const countBefore = collected.length;
    sub.unsubscribe();

    // Add more events after unsubscribe
    await store.add(makeEvent({ id: 'b' }));
    await store.add(makeEvent({ id: 'c' }));
    await wait();

    // Should NOT have received updates after unsubscribe
    expect(collected.length).toBe(countBefore);
  });

  it('multiple queries can independently unsubscribe', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    const collected1: number[] = [];
    const collected2: number[] = [];

    const sub1 = store.query({ kinds: [1] }).subscribe((e) => collected1.push(e.length));
    const sub2 = store.query({ kinds: [1] }).subscribe((e) => collected2.push(e.length));

    await wait();
    await store.add(makeEvent({ id: 'a' }));
    await wait();

    sub1.unsubscribe();

    await store.add(makeEvent({ id: 'b' }));
    await wait();

    // sub1 stopped, sub2 continues
    const count1After = collected1.length;
    expect(collected2.length).toBeGreaterThan(count1After);

    sub2.unsubscribe();
  });
});
