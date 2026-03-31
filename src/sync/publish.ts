import type { Observable } from 'rxjs';
import type { NostrEvent } from '../types.js';
import type { EventStore } from '../core/store.js';

/** Unsigned event parameters (signer required) */
export interface UnsignedEventParams {
  kind: number;
  tags?: string[][];
  content?: string;
  created_at?: number;
}

/** Input to publishEvent: either a signed event or unsigned params */
export type EventParams = NostrEvent | UnsignedEventParams;

/** Relay OK response packet */
export interface OkPacketLike {
  ok: boolean;
  from: string;
}

/** Signer function: takes unsigned params, returns signed event */
export type EventSigner = (params: UnsignedEventParams) => Promise<NostrEvent>;

export interface PublishOptions {
  signer?: EventSigner;
  optimistic?: boolean;
  on?: { relays?: string[] };
}

/** Minimal rx-nostr contract for publishing */
export interface RxNostrSendLike {
  send(
    params: EventParams,
    options?: { signer?: EventSigner; on?: { relays?: string[] } },
  ): Observable<OkPacketLike>;
}

export function publishEvent(
  rxNostr: RxNostrSendLike,
  store: EventStore,
  eventParams: EventParams,
  options?: PublishOptions,
): Observable<OkPacketLike> {
  // If optimistic and event is pre-signed (has id+sig), add to store immediately
  if (
    options?.optimistic &&
    'id' in eventParams &&
    'sig' in eventParams &&
    eventParams.id &&
    eventParams.sig
  ) {
    void store.add(eventParams as NostrEvent);
  }

  const sendOptions: { signer?: EventSigner; on?: { relays?: string[] } } = {};
  if (options?.signer) sendOptions.signer = options.signer;
  if (options?.on) sendOptions.on = options.on;

  return rxNostr.send(eventParams, sendOptions);
}
