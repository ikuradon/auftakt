import { describe, it, expect, vi } from 'vitest';
import { Subject, firstValueFrom, filter } from 'rxjs';
import { publishEvent } from '../../src/sync/publish.js';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import type { CachedEvent } from '../../src/types.js';

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('publishEvent', () => {
  it('calls rxNostr.send and returns ok$', () => {
    const okSubject = new Subject<any>();
    const mockRxNostr = { send: vi.fn(() => okSubject.asObservable()) };
    const store = createEventStore({ backend: memoryBackend() });

    const ok$ = publishEvent(mockRxNostr as any, store, { kind: 1, content: 'hello', tags: [] });
    expect(ok$).toBeDefined();
    expect(mockRxNostr.send).toHaveBeenCalled();
  });

  it('adds signed event to store when optimistic: true', async () => {
    const okSubject = new Subject<any>();
    const mockRxNostr = { send: vi.fn(() => okSubject.asObservable()) };
    const store = createEventStore({ backend: memoryBackend() });

    const signedEvent = {
      id: 'signed1',
      kind: 1,
      pubkey: 'pk1',
      created_at: 1000,
      tags: [],
      content: 'hello',
      sig: 'sig1',
    };

    publishEvent(mockRxNostr as any, store, signedEvent, { optimistic: true });
    await wait();

    const events = await firstValueFrom(
      store.query({ ids: ['signed1'] }).pipe(filter((e: CachedEvent[]) => e.length > 0)),
    );
    expect(events).toHaveLength(1);
  });

  it('does not add to store when optimistic is false/undefined', async () => {
    const okSubject = new Subject<any>();
    const mockRxNostr = { send: vi.fn(() => okSubject.asObservable()) };
    const store = createEventStore({ backend: memoryBackend() });

    const signedEvent = {
      id: 'signed2',
      kind: 1,
      pubkey: 'pk1',
      created_at: 1000,
      tags: [],
      content: 'hello',
      sig: 'sig1',
    };

    publishEvent(mockRxNostr as any, store, signedEvent);
    await wait();

    const events = await firstValueFrom(store.query({ ids: ['signed2'] }));
    expect(events).toHaveLength(0);
  });

  it('passes signer and on options to rxNostr.send', () => {
    const okSubject = new Subject<any>();
    const mockRxNostr = { send: vi.fn(() => okSubject.asObservable()) };
    const store = createEventStore({ backend: memoryBackend() });
    const signer = { sign: vi.fn() };

    publishEvent(mockRxNostr as any, store, { kind: 1 } as any, {
      signer,
      on: { relays: ['wss://relay1'] },
    });

    expect(mockRxNostr.send).toHaveBeenCalledWith(
      { kind: 1 },
      expect.objectContaining({ signer, on: { relays: ['wss://relay1'] } }),
    );
  });
});
