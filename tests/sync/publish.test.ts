import { describe, it, expect, vi } from 'vitest';
import { Subject, firstValueFrom, filter } from 'rxjs';
import { publishEvent } from '../../src/sync/publish.js';
import type { OkPacketLike, RxNostrSendLike } from '../../src/sync/publish.js';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import type { NostrEvent, CachedEvent } from '../../src/types.js';

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function createMockRxNostr(): RxNostrSendLike & { okSubject: Subject<OkPacketLike> } {
  const okSubject = new Subject<OkPacketLike>();
  return {
    okSubject,
    send: vi.fn(() => okSubject.asObservable()),
  };
}

const signedEvent: NostrEvent = {
  id: 'signed1',
  kind: 1,
  pubkey: 'pk1',
  created_at: 1000,
  tags: [],
  content: 'hello',
  sig: 'sig1',
};

describe('publishEvent', () => {
  it('calls rxNostr.send and returns ok$', () => {
    const mockRxNostr = createMockRxNostr();
    const store = createEventStore({ backend: memoryBackend() });

    const ok$ = publishEvent(mockRxNostr, store, { kind: 1, content: 'hello', tags: [] });
    expect(ok$).toBeDefined();
    expect(mockRxNostr.send).toHaveBeenCalled();
  });

  it('adds signed event to store when optimistic: true', async () => {
    const mockRxNostr = createMockRxNostr();
    const store = createEventStore({ backend: memoryBackend() });

    publishEvent(mockRxNostr, store, signedEvent, { optimistic: true });
    await wait();

    const events = await firstValueFrom(
      store.query({ ids: ['signed1'] }).pipe(filter((e: CachedEvent[]) => e.length > 0)),
    );
    expect(events).toHaveLength(1);
  });

  it('does not add to store when optimistic is false/undefined', async () => {
    const mockRxNostr = createMockRxNostr();
    const store = createEventStore({ backend: memoryBackend() });

    publishEvent(mockRxNostr, store, { ...signedEvent, id: 'signed2' });
    await wait();

    const events = await firstValueFrom(store.query({ ids: ['signed2'] }));
    expect(events).toHaveLength(0);
  });

  it('passes signer and on options to rxNostr.send', () => {
    const mockRxNostr = createMockRxNostr();
    const store = createEventStore({ backend: memoryBackend() });

    const signer = async (params: { kind: number }) =>
      ({
        ...params,
        id: 'x',
        pubkey: 'pk',
        sig: 's',
        created_at: 0,
        tags: [],
        content: '',
      }) as NostrEvent;

    publishEvent(
      mockRxNostr,
      store,
      { kind: 1, tags: [], content: '' },
      {
        signer,
        on: { relays: ['wss://relay1'] },
      },
    );

    expect(mockRxNostr.send).toHaveBeenCalledWith(
      { kind: 1, tags: [], content: '' },
      expect.objectContaining({ on: { relays: ['wss://relay1'] } }),
    );
  });

  it('returns typed Observable<OkPacketLike>', () => {
    const mockRxNostr = createMockRxNostr();
    const store = createEventStore({ backend: memoryBackend() });

    const ok$ = publishEvent(mockRxNostr, store, signedEvent);

    const results: OkPacketLike[] = [];
    ok$.subscribe((pkt) => results.push(pkt));

    mockRxNostr.okSubject.next({ ok: true, from: 'wss://relay1' });
    mockRxNostr.okSubject.complete();

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].from).toBe('wss://relay1');
  });
});
