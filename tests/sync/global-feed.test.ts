import { describe, it, expect, vi } from 'vitest';
import { Subject, firstValueFrom, skip } from 'rxjs';
import { connectStore } from '../../src/sync/global-feed.js';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import type { NostrEvent } from '../../src/types.js';

const flush = () => new Promise(r => setTimeout(r, 20));

const makePacket = (eventOverrides: Partial<NostrEvent> = {}, from = 'wss://relay1') => ({
  event: {
    id: 'e1', kind: 1, pubkey: 'pk1', created_at: 1000,
    tags: [], content: 'hello', sig: 'sig1',
    ...eventOverrides,
  } as NostrEvent,
  from,
  subId: 'sub1',
  type: 'EVENT' as const,
  message: ['EVENT', 'sub1', {}] as any,
});

function createMockRxNostr() {
  const allEvents$ = new Subject<any>();
  return {
    allEvents$,
    createAllEventObservable: () => allEvents$.asObservable(),
  };
}

describe('connectStore', () => {
  it('feeds events from rxNostr to store', async () => {
    const mock = createMockRxNostr();
    const store = createEventStore({ backend: memoryBackend() });
    connectStore(mock as any, store);

    mock.allEvents$.next(makePacket());
    await flush();

    const events = await firstValueFrom(store.query({ ids: ['e1'] }).pipe(skip(1)));
    expect(events).toHaveLength(1);
    expect(events[0].seenOn).toContain('wss://relay1');
  });

  it('applies filter to exclude events', async () => {
    const mock = createMockRxNostr();
    const store = createEventStore({ backend: memoryBackend() });
    connectStore(mock as any, store, {
      filter: (event) => event.kind !== 4,
    });

    mock.allEvents$.next(makePacket({ id: 'dm1', kind: 4 }));
    mock.allEvents$.next(makePacket({ id: 'note1', kind: 1 }));
    await flush();

    const dm = await firstValueFrom(store.query({ ids: ['dm1'] }).pipe(skip(1)));
    expect(dm).toHaveLength(0);
    const note = await firstValueFrom(store.query({ ids: ['note1'] }).pipe(skip(1)));
    expect(note).toHaveLength(1);
  });

  it('passes relay info to filter', async () => {
    const mock = createMockRxNostr();
    const store = createEventStore({ backend: memoryBackend() });
    const relaysSeen: string[] = [];
    connectStore(mock as any, store, {
      filter: (_event, meta) => {
        relaysSeen.push(meta.relay);
        return true;
      },
    });

    mock.allEvents$.next(makePacket({ id: 'a' }, 'wss://special'));
    await flush();
    expect(relaysSeen).toContain('wss://special');
  });

  it('returns disconnect function', async () => {
    const mock = createMockRxNostr();
    const store = createEventStore({ backend: memoryBackend() });
    const disconnect = connectStore(mock as any, store);
    disconnect();

    mock.allEvents$.next(makePacket({ id: 'after' }));
    await flush();

    const events = await firstValueFrom(store.query({ ids: ['after'] }).pipe(skip(1)));
    expect(events).toHaveLength(0);
  });

  it('reconcileDeletions fetches kind:5 for cached events on connect', async () => {
    const store = createEventStore({ backend: memoryBackend() });
    await store.add({
      id: 'cached1', kind: 1, pubkey: 'pk1', created_at: 1000,
      tags: [], content: '', sig: 'sig1',
    } as NostrEvent);

    const allEvents$ = new Subject<any>();
    const useMock = vi.fn((_req: unknown) => {
      const subject = new Subject<{ event: NostrEvent; from: string }>();
      setTimeout(() => {
        subject.next({
          event: {
            id: 'del1', kind: 5, pubkey: 'pk1', created_at: 2000,
            tags: [['e', 'cached1']], content: '', sig: 'sig-del',
          },
          from: 'wss://relay1',
        });
        subject.complete();
      }, 5);
      return subject.asObservable();
    });

    const mockRxNostr = {
      createAllEventObservable: () => allEvents$.asObservable(),
      use: useMock,
    };

    connectStore(mockRxNostr as any, store, { reconcileDeletions: true });
    await new Promise(r => setTimeout(r, 200));

    const result = await store.add({
      id: 'cached1', kind: 1, pubkey: 'pk1', created_at: 1000,
      tags: [], content: '', sig: 'sig1',
    } as NostrEvent);
    expect(result).toBe('deleted');
  });

  it('excludes ephemeral events automatically (store rejects)', async () => {
    const mock = createMockRxNostr();
    const store = createEventStore({ backend: memoryBackend() });
    connectStore(mock as any, store);

    mock.allEvents$.next(makePacket({ id: 'eph1', kind: 20001 }));
    await flush();

    const events = await firstValueFrom(store.query({ ids: ['eph1'] }).pipe(skip(1)));
    expect(events).toHaveLength(0);
  });
});
