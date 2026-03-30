import type { Observable } from 'rxjs';
import type { NostrEvent } from '../types.js';
import type { EventStore } from '../core/store.js';

interface PublishOptions {
  signer?: any;
  optimistic?: boolean;
  on?: { relays?: string[] };
}

export function publishEvent(
  rxNostr: { send(params: any, options?: any): Observable<any> },
  store: EventStore,
  eventParams: any,
  options?: PublishOptions,
): Observable<any> {
  if (options?.optimistic && eventParams.id && eventParams.sig) {
    void store.add(eventParams as NostrEvent);
  }

  const sendOptions: Record<string, unknown> = {};
  if (options?.signer) sendOptions.signer = options.signer;
  if (options?.on) sendOptions.on = options.on;

  return rxNostr.send(eventParams, sendOptions);
}
