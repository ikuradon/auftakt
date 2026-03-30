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

export interface PublishOptions {
  signer?: unknown;
  optimistic?: boolean;
  on?: { relays?: string[] };
}

interface RxNostrSendLike {
  send(params: EventParams, options?: Record<string, unknown>): Observable<unknown>;
}

export function publishEvent(
  rxNostr: RxNostrSendLike,
  store: EventStore,
  eventParams: EventParams,
  options?: PublishOptions,
): Observable<unknown> {
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

  const sendOptions: Record<string, unknown> = {};
  if (options?.signer) sendOptions.signer = options.signer;
  if (options?.on) sendOptions.on = options.on;

  return rxNostr.send(eventParams, sendOptions);
}
