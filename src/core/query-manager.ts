import { BehaviorSubject, Observable } from 'rxjs';
import type { NostrFilter, CachedEvent } from '../types.js';
import type { StoredEvent } from '../backends/interface.js';
import { matchesFilter } from './filter-matcher.js';
import { isExpired } from './nip-rules.js';

interface ActiveQuery {
  id: number;
  filter: NostrFilter;
  subject: BehaviorSubject<CachedEvent[]>;
}

export class QueryManager {
  private nextId = 0;
  private queries = new Map<number, ActiveQuery>();
  private pendingDirty = new Set<number>();
  private flushScheduled = false;
  private deletedIds: Set<string>;
  private queryFn: ((filter: NostrFilter) => Promise<StoredEvent[]>) | null = null;

  constructor(deletedIds: Set<string>) {
    this.deletedIds = deletedIds;
  }

  setQueryFn(fn: (filter: NostrFilter) => Promise<StoredEvent[]>): void {
    this.queryFn = fn;
  }

  registerQuery(filter: NostrFilter): { id: number; observable: Observable<CachedEvent[]> } {
    const id = this.nextId++;
    const subject = new BehaviorSubject<CachedEvent[]>([]);
    this.queries.set(id, { id, filter, subject });
    this.markDirty(id);
    return { id, observable: subject.asObservable() };
  }

  unregisterQuery(queryId: number): void {
    const query = this.queries.get(queryId);
    if (query) {
      query.subject.complete();
      this.queries.delete(queryId);
      this.pendingDirty.delete(queryId);
    }
  }

  notifyPotentialChange(event: StoredEvent): void {
    for (const query of this.queries.values()) {
      if (matchesFilter(event.event, query.filter)) {
        this.markDirty(query.id);
      }
    }
  }

  notifyDeletion(): void {
    for (const query of this.queries.values()) {
      this.markDirty(query.id);
    }
  }

  private markDirty(queryId: number): void {
    this.pendingDirty.add(queryId);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    const dirty = new Set(this.pendingDirty);
    this.pendingDirty.clear();
    this.flushScheduled = false;

    if (!this.queryFn) return;

    for (const queryId of dirty) {
      const query = this.queries.get(queryId);
      if (!query) continue;
      this.queryFn(query.filter).then(results => {
        if (!this.queries.has(queryId)) return;
        query.subject.next(this.toOutput(results));
      });
    }
  }

  private toOutput(results: StoredEvent[]): CachedEvent[] {
    const now = Math.floor(Date.now() / 1000);
    return results
      .filter(s => !this.deletedIds.has(s.event.id))
      .filter(s => !isExpired(s.event, now))
      .sort((a, b) => b.event.created_at - a.event.created_at)
      .map(s => ({
        event: s.event,
        seenOn: s.seenOn,
        firstSeen: s.firstSeen,
      }));
  }
}
