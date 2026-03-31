import { describe, it, expect, vi } from 'vitest';
import { Subject, firstValueFrom, toArray } from 'rxjs';
import { sendEvent, castEvent, SigningError } from '../../src/sync/publish.js';
import type { OkPacketLike, RxNostrSendLike, RxNostrCastLike } from '../../src/sync/publish.js';
import { createEventStore } from '../../src/core/store.js';
import { memoryBackend } from '../../src/backends/memory.js';
import type { NostrEvent } from '../../src/types.js';

const signedEvent: NostrEvent = {
  id: 'e1',
  kind: 1,
  pubkey: 'pk1',
  created_at: 1000,
  tags: [],
  content: 'hello',
  sig: 'sig1',
};

const unsignedParams = { kind: 1, content: 'hello', tags: [] as string[][] };

const fakeSigner = async (params: { kind: number; content?: string; tags?: string[][] }) =>
  ({
    ...params,
    id: 'signed-id',
    pubkey: 'pk1',
    created_at: Math.floor(Date.now() / 1000),
    tags: params.tags ?? [],
    content: params.content ?? '',
    sig: 'signed-sig',
  }) as NostrEvent;

function createMockSend(): RxNostrSendLike & { complete: () => void } {
  const subjects = new Map<number, Subject<OkPacketLike>>();
  let callCount = 0;
  return {
    send: vi.fn(() => {
      const subject = new Subject<OkPacketLike>();
      subjects.set(callCount++, subject);
      // Auto-respond with ok after a tick
      setTimeout(() => {
        subject.next({ ok: true, from: 'wss://relay1' });
        subject.complete();
      }, 5);
      return subject.asObservable();
    }),
    complete: () => {
      for (const s of subjects.values()) s.complete();
    },
  };
}

function createMockCast(): RxNostrCastLike {
  return {
    cast: vi.fn(async () => {}),
  };
}

// ========== sendEvent ==========

describe('sendEvent', () => {
  it('sends a pre-signed event and returns ok packets', async () => {
    const mock = createMockSend();
    const store = createEventStore({ backend: memoryBackend() });

    const results = await firstValueFrom(sendEvent(mock, store, signedEvent).pipe(toArray()));

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(mock.send).toHaveBeenCalledWith(signedEvent, expect.any(Object));
  });

  it('signs unsigned event before sending', async () => {
    const mock = createMockSend();
    const store = createEventStore({ backend: memoryBackend() });

    const results = await firstValueFrom(
      sendEvent(mock, store, unsignedParams, { signer: fakeSigner }).pipe(toArray()),
    );

    expect(results).toHaveLength(1);
    const sentEvent = (mock.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sentEvent.id).toBe('signed-id');
    expect(sentEvent.sig).toBe('signed-sig');
  });

  it('adds to store optimistically after signing', async () => {
    const mock = createMockSend();
    const store = createEventStore({ backend: memoryBackend() });

    await firstValueFrom(
      sendEvent(mock, store, unsignedParams, {
        signer: fakeSigner,
        optimistic: true,
      }).pipe(toArray()),
    );

    const events = await store.getSync({ ids: ['signed-id'] });
    expect(events).toHaveLength(1);
  });

  it('adds pre-signed event to store when optimistic', async () => {
    const mock = createMockSend();
    const store = createEventStore({ backend: memoryBackend() });

    await firstValueFrom(sendEvent(mock, store, signedEvent, { optimistic: true }).pipe(toArray()));

    const events = await store.getSync({ ids: ['e1'] });
    expect(events).toHaveLength(1);
  });

  it('does not add to store when optimistic is false', async () => {
    const mock = createMockSend();
    const store = createEventStore({ backend: memoryBackend() });

    await firstValueFrom(sendEvent(mock, store, signedEvent).pipe(toArray()));

    const events = await store.getSync({ ids: ['e1'] });
    expect(events).toHaveLength(0);
  });

  it('throws SigningError when signer fails', async () => {
    const mock = createMockSend();
    const store = createEventStore({ backend: memoryBackend() });
    const badSigner = async () => {
      throw new Error('NIP-07 rejected');
    };

    await expect(
      firstValueFrom(sendEvent(mock, store, unsignedParams, { signer: badSigner })),
    ).rejects.toThrow(SigningError);
  });

  it('throws SigningError when unsigned event has no signer', async () => {
    const mock = createMockSend();
    const store = createEventStore({ backend: memoryBackend() });

    await expect(firstValueFrom(sendEvent(mock, store, unsignedParams))).rejects.toThrow(
      SigningError,
    );
  });

  it('passes on option to rxNostr.send', async () => {
    const mock = createMockSend();
    const store = createEventStore({ backend: memoryBackend() });

    await firstValueFrom(
      sendEvent(mock, store, signedEvent, {
        on: { relays: ['wss://specific'] },
      }).pipe(toArray()),
    );

    expect(mock.send).toHaveBeenCalledWith(
      signedEvent,
      expect.objectContaining({ on: { relays: ['wss://specific'] } }),
    );
  });
});

// ========== castEvent ==========

describe('castEvent', () => {
  it('casts a pre-signed event', async () => {
    const mock = createMockCast();
    const store = createEventStore({ backend: memoryBackend() });

    await castEvent(mock, store, signedEvent);

    expect(mock.cast).toHaveBeenCalledWith(signedEvent, expect.any(Object));
  });

  it('signs unsigned event before casting', async () => {
    const mock = createMockCast();
    const store = createEventStore({ backend: memoryBackend() });

    await castEvent(mock, store, unsignedParams, { signer: fakeSigner });

    const sentEvent = (mock.cast as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sentEvent.id).toBe('signed-id');
    expect(sentEvent.sig).toBe('signed-sig');
  });

  it('adds to store optimistically after signing', async () => {
    const mock = createMockCast();
    const store = createEventStore({ backend: memoryBackend() });

    await castEvent(mock, store, unsignedParams, {
      signer: fakeSigner,
      optimistic: true,
    });

    const events = await store.getSync({ ids: ['signed-id'] });
    expect(events).toHaveLength(1);
  });

  it('does not add to store when optimistic is false', async () => {
    const mock = createMockCast();
    const store = createEventStore({ backend: memoryBackend() });

    await castEvent(mock, store, signedEvent);

    const events = await store.getSync({ ids: ['e1'] });
    expect(events).toHaveLength(0);
  });

  it('throws SigningError when signer fails', async () => {
    const mock = createMockCast();
    const store = createEventStore({ backend: memoryBackend() });
    const badSigner = async () => {
      throw new Error('NIP-07 rejected');
    };

    await expect(castEvent(mock, store, unsignedParams, { signer: badSigner })).rejects.toThrow(
      SigningError,
    );
  });

  it('throws SigningError when unsigned event has no signer', async () => {
    const mock = createMockCast();
    const store = createEventStore({ backend: memoryBackend() });

    await expect(castEvent(mock, store, unsignedParams)).rejects.toThrow(SigningError);
  });

  it('passes on option to rxNostr.cast', async () => {
    const mock = createMockCast();
    const store = createEventStore({ backend: memoryBackend() });

    await castEvent(mock, store, signedEvent, { on: { relays: ['wss://specific'] } });

    expect(mock.cast).toHaveBeenCalledWith(
      signedEvent,
      expect.objectContaining({ on: { relays: ['wss://specific'] } }),
    );
  });
});
