import { type Observable, from } from 'rxjs';
import { switchMap, tap } from 'rxjs/operators';
import type { NostrEvent } from '../types.js';
import type { EventStore } from '../core/store.js';

/** Unsigned event parameters (signer required) */
export interface UnsignedEventParams {
  kind: number;
  tags?: string[][];
  content?: string;
  created_at?: number;
}

/** Input to sendEvent/castEvent: either a signed event or unsigned params */
export type EventParams = NostrEvent | UnsignedEventParams;

/** Relay OK response packet */
export interface OkPacketLike {
  ok: boolean;
  from: string;
}

/** Signer function: takes unsigned params, returns signed event */
export type EventSigner = (params: UnsignedEventParams) => Promise<NostrEvent>;

/** Error thrown when signing fails or signer is missing */
export class SigningError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SigningError';
  }
}

export interface SendOptions {
  signer?: EventSigner;
  optimistic?: boolean;
  on?: { relays?: string[] };
}

export type CastOptions = SendOptions;

/** Minimal rx-nostr contract for send */
export interface RxNostrSendLike {
  send(params: NostrEvent, options?: { on?: { relays?: string[] } }): Observable<OkPacketLike>;
}

/** Minimal rx-nostr contract for cast */
export interface RxNostrCastLike {
  cast(params: NostrEvent, options?: { on?: { relays?: string[] } }): Promise<void>;
}

function isSigned(params: EventParams): params is NostrEvent {
  return 'id' in params && 'sig' in params && !!params.id && !!params.sig;
}

async function resolveEvent(params: EventParams, signer?: EventSigner): Promise<NostrEvent> {
  if (isSigned(params)) return params;
  if (!signer) throw new SigningError('Signer is required for unsigned events');
  try {
    return await signer(params as UnsignedEventParams);
  } catch (err) {
    if (err instanceof SigningError) throw err;
    throw new SigningError('Failed to sign event', { cause: err });
  }
}

function buildRelayOptions(options?: SendOptions): { on?: { relays?: string[] } } {
  const result: { on?: { relays?: string[] } } = {};
  if (options?.on) result.on = options.on;
  return result;
}

/**
 * Sign (if needed) and send an event via rx-nostr.
 * Returns Observable<OkPacketLike> — each relay's OK/NG response.
 */
export function sendEvent(
  rxNostr: RxNostrSendLike,
  store: EventStore,
  eventParams: EventParams,
  options?: SendOptions,
): Observable<OkPacketLike> {
  return from(resolveEvent(eventParams, options?.signer)).pipe(
    tap((signed) => {
      if (options?.optimistic) void store.add(signed);
    }),
    switchMap((signed) => rxNostr.send(signed, buildRelayOptions(options))),
  );
}

/**
 * Sign (if needed) and cast an event via rx-nostr.
 * Returns Promise<void> — resolves when at least one relay accepts.
 */
export async function castEvent(
  rxNostr: RxNostrCastLike,
  store: EventStore,
  eventParams: EventParams,
  options?: CastOptions,
): Promise<void> {
  let signed: NostrEvent;
  try {
    signed = await resolveEvent(eventParams, options?.signer);
  } catch (err) {
    if (err instanceof SigningError) throw err;
    throw new SigningError('Failed to sign event', { cause: err });
  }
  if (options?.optimistic) void store.add(signed);
  await rxNostr.cast(signed, buildRelayOptions(options));
}
