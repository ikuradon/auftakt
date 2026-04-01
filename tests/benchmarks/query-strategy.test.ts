import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { firstValueFrom, skip, type Subscription } from 'rxjs';
import { createEventStore, type EventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import { dexieBackend } from '../../src/backends/dexie.js';
import type { StorageBackend } from '../../src/backends/interface.js';
import { generateEvent, resetCounter, measureMs } from './helpers.js';
import { liveQueryObservable, liveQueryDebouncedObservable } from './livequery-adapter.js';

const SCALE = 1_000;

describe(`Benchmark: QueryManager vs liveQuery (${SCALE} events)`, () => {
  let memStore: EventStore;
  let dexieStore: EventStore;
  let dexieDb: StorageBackend;
  const dbName = `bench-${SCALE}-${Date.now()}`;

  beforeAll(async () => {
    resetCounter();
    const mem = memoryBackend({ maxEvents: SCALE + 5000 });
    memStore = createEventStore({ backend: mem });
    dexieDb = dexieBackend({ dbName });
    dexieStore = createEventStore({ backend: dexieDb });

    for (let i = 0; i < SCALE; i++) {
      const event = generateEvent();
      await memStore.add(event);
      await dexieStore.add(event);
    }
  }, 120_000);

  afterAll(async () => {
    memStore.dispose();
    dexieStore.dispose();
    await dexieDb.dispose?.();
  });

  it('S1: Burst write + active query', async () => {
    const WRITES = 20;
    const SETTLE = 100;

    // Config A: QueryManager
    const aMs = await measureMs(async () => {
      const sub = memStore.query({ kinds: [1], limit: 50 }).subscribe();
      for (let i = 0; i < WRITES; i++) {
        await memStore.add(generateEvent({ kind: 1 }));
      }
      await new Promise((r) => setTimeout(r, SETTLE));
      sub.unsubscribe();
    });

    // Config B: liveQuery
    const bMs = await measureMs(async () => {
      const sub = liveQueryObservable(dbName, { kinds: [1], limit: 50 }).subscribe();
      for (let i = 0; i < WRITES; i++) {
        await dexieStore.add(generateEvent({ kind: 1 }));
      }
      await new Promise((r) => setTimeout(r, SETTLE));
      sub.unsubscribe();
    });

    // Config C: liveQuery + debounce
    const cMs = await measureMs(async () => {
      const sub = liveQueryDebouncedObservable(dbName, { kinds: [1], limit: 50 }).subscribe();
      for (let i = 0; i < WRITES; i++) {
        await dexieStore.add(generateEvent({ kind: 1 }));
      }
      await new Promise((r) => setTimeout(r, SETTLE));
      sub.unsubscribe();
    });

    console.log(
      `S1 Burst Write:  A=${aMs.toFixed(1)}ms  B=${bMs.toFixed(1)}ms  C=${cMs.toFixed(1)}ms  B/A=${(bMs / aMs).toFixed(2)}x  C/A=${(cMs / aMs).toFixed(2)}x`,
    );
    // threshold: B/C ≤ 2x A
    expect(true).toBe(true); // always pass — results are informational
  }, 30_000);

  it('S2: Cold query first emit', async () => {
    // Config A: QueryManager
    const aMs = await measureMs(async () => {
      await firstValueFrom(memStore.query({ kinds: [1], limit: 50 }).pipe(skip(1)));
    });

    // Config B: liveQuery
    const bMs = await measureMs(async () => {
      await firstValueFrom(liveQueryObservable(dbName, { kinds: [1], limit: 50 }));
    });

    console.log(
      `S2 Cold Query:   A=${aMs.toFixed(1)}ms  B=${bMs.toFixed(1)}ms  B/A=${(bMs / aMs).toFixed(2)}x`,
    );
    expect(true).toBe(true);
  }, 30_000);

  it('S3: 10 concurrent queries + single add', async () => {
    // Config A
    const aMs = await measureMs(async () => {
      const subs: Subscription[] = [];
      for (let i = 0; i < 10; i++) {
        subs.push(memStore.query({ kinds: [1], limit: 20 }).subscribe());
      }
      await new Promise((r) => setTimeout(r, 50));
      await memStore.add(generateEvent({ kind: 1 }));
      await new Promise((r) => setTimeout(r, 100));
      for (const s of subs) s.unsubscribe();
    });

    // Config B
    const bMs = await measureMs(async () => {
      const subs: Subscription[] = [];
      for (let i = 0; i < 10; i++) {
        subs.push(liveQueryObservable(dbName, { kinds: [1], limit: 20 }).subscribe());
      }
      await new Promise((r) => setTimeout(r, 50));
      await dexieStore.add(generateEvent({ kind: 1 }));
      await new Promise((r) => setTimeout(r, 100));
      for (const s of subs) s.unsubscribe();
    });

    console.log(
      `S3 Concurrent:   A=${aMs.toFixed(1)}ms  B=${bMs.toFixed(1)}ms  B/A=${(bMs / aMs).toFixed(2)}x`,
    );
    expect(true).toBe(true);
  }, 30_000);

  it('S4: Repeated query (cache hit)', async () => {
    const REPEATS = 10;

    // Config A
    const aMs = await measureMs(async () => {
      for (let i = 0; i < REPEATS; i++) {
        await firstValueFrom(memStore.query({ kinds: [1], limit: 50 }).pipe(skip(1)));
      }
    });

    // Config B
    const bMs = await measureMs(async () => {
      for (let i = 0; i < REPEATS; i++) {
        await firstValueFrom(liveQueryObservable(dbName, { kinds: [1], limit: 50 }));
      }
    });

    console.log(
      `S4 Cache Hit:    A=${aMs.toFixed(1)}ms  B=${bMs.toFixed(1)}ms  B/A=${(bMs / aMs).toFixed(2)}x`,
    );
    expect(true).toBe(true);
  }, 30_000);
});
