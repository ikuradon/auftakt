import { BehaviorSubject, Observable } from 'rxjs';
import type { NostrFilter, CachedEvent } from '../types.js';
import type { StoredEvent } from '../backends/interface.js';
import { matchesFilter } from './filter-matcher.js';
import { isExpired } from './nip-rules.js';

interface ActiveQuery {
  id: number;
  filter: NostrFilter;
  subject: BehaviorSubject<CachedEvent[]>;
  cachedResults: CachedEvent[];
}

type ChangeType = 'added' | 'replaced' | 'deleted';

export class QueryManager {
  private nextId = 0;
  private queries = new Map<number, ActiveQuery>();
  private pendingDirty = new Set<number>();
  private pendingFullRefresh = new Set<number>();
  private pendingAddedEvents = new Map<number, StoredEvent[]>();
  private flushScheduled = false;
  private deletedIds: Set<string>;
  private queryFn: ((filter: NostrFilter) => Promise<StoredEvent[]>) | null = null;

  // Reverse indexes
  private kindIndex = new Map<number, Set<number>>();
  private authorIndex = new Map<string, Set<number>>();
  private wildcardSet = new Set<number>();

  constructor(deletedIds: Set<string>) {
    this.deletedIds = deletedIds;
  }

  setQueryFn(fn: (filter: NostrFilter) => Promise<StoredEvent[]>): void {
    this.queryFn = fn;
  }

  registerQuery(filter: NostrFilter): { id: number; observable: Observable<CachedEvent[]> } {
    const id = this.nextId++;
    const subject = new BehaviorSubject<CachedEvent[]>([]);
    this.queries.set(id, { id, filter, subject, cachedResults: [] });

    // Index the query
    this.indexQuery(id, filter);

    // Initial load requires full backend query
    this.pendingFullRefresh.add(id);
    this.markDirty(id);
    return { id, observable: subject.asObservable() };
  }

  unregisterQuery(queryId: number): void {
    const query = this.queries.get(queryId);
    if (query) {
      this.deindexQuery(queryId, query.filter);
      query.subject.complete();
      this.queries.delete(queryId);
      this.pendingDirty.delete(queryId);
    }
  }

  notifyPotentialChange(event: StoredEvent, changeType: ChangeType = 'added'): void {
    const candidates = this.getCandidateQueries(event.event.kind, event.event.pubkey);
    for (const queryId of candidates) {
      const query = this.queries.get(queryId);
      if (!query) continue;
      if (!matchesFilter(event.event, query.filter)) continue;

      if (changeType === 'added') {
        // Track for differential update
        let events = this.pendingAddedEvents.get(queryId);
        if (!events) {
          events = [];
          this.pendingAddedEvents.set(queryId, events);
        }
        events.push(event);
        this.markDirty(queryId);
      } else {
        // replaced → full refresh
        this.pendingFullRefresh.add(queryId);
        this.markDirty(queryId);
      }
    }
  }

  notifyDeletion(event: StoredEvent): void {
    const candidates = this.getCandidateQueries(event.event.kind, event.event.pubkey);
    for (const queryId of candidates) {
      this.pendingFullRefresh.add(queryId);
      this.markDirty(queryId);
    }
  }

  private getCandidateQueries(kind: number, pubkey: string): Set<number> {
    const candidates = new Set<number>(this.wildcardSet);
    const byKind = this.kindIndex.get(kind);
    if (byKind) {
      for (const id of byKind) candidates.add(id);
    }
    const byAuthor = this.authorIndex.get(pubkey);
    if (byAuthor) {
      for (const id of byAuthor) candidates.add(id);
    }
    return candidates;
  }

  private indexQuery(queryId: number, filter: NostrFilter): void {
    const hasKinds = filter.kinds && filter.kinds.length > 0;
    const hasAuthors = filter.authors && filter.authors.length > 0;

    if (!hasKinds && !hasAuthors) {
      this.wildcardSet.add(queryId);
      return;
    }

    if (hasKinds) {
      for (const kind of filter.kinds!) {
        let set = this.kindIndex.get(kind);
        if (!set) {
          set = new Set();
          this.kindIndex.set(kind, set);
        }
        set.add(queryId);
      }
    } else {
      // Has authors but no kinds — wildcard for kinds
      this.wildcardSet.add(queryId);
    }

    if (hasAuthors) {
      for (const author of filter.authors!) {
        let set = this.authorIndex.get(author);
        if (!set) {
          set = new Set();
          this.authorIndex.set(author, set);
        }
        set.add(queryId);
      }
    }
  }

  private deindexQuery(queryId: number, filter: NostrFilter): void {
    this.wildcardSet.delete(queryId);

    if (filter.kinds) {
      for (const kind of filter.kinds) {
        const set = this.kindIndex.get(kind);
        if (set) {
          set.delete(queryId);
          if (set.size === 0) this.kindIndex.delete(kind);
        }
      }
    }

    if (filter.authors) {
      for (const author of filter.authors) {
        const set = this.authorIndex.get(author);
        if (set) {
          set.delete(queryId);
          if (set.size === 0) this.authorIndex.delete(author);
        }
      }
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
    const fullRefresh = new Set(this.pendingFullRefresh);
    const addedEvents = new Map(this.pendingAddedEvents);
    this.pendingDirty.clear();
    this.pendingFullRefresh.clear();
    this.pendingAddedEvents.clear();
    this.flushScheduled = false;

    if (!this.queryFn) return;

    for (const queryId of dirty) {
      const query = this.queries.get(queryId);
      if (!query) continue;

      if (fullRefresh.has(queryId)) {
        // Full backend query
        this.queryFn(query.filter).then(results => {
          if (!this.queries.has(queryId)) return;
          const output = this.toOutput(results);
          query.cachedResults = output;
          query.subject.next(output);
        }).catch(err => {
          console.warn('[auftakt] Query refresh failed:', err);
        });
      } else {
        // Differential: insert added events into cached results
        const events = addedEvents.get(queryId);
        if (events && events.length > 0) {
          const now = Math.floor(Date.now() / 1000);
          const newItems: CachedEvent[] = events
            .filter(s => !this.deletedIds.has(s.event.id))
            .filter(s => !isExpired(s.event, now))
            .map(s => ({ event: s.event, seenOn: s.seenOn, firstSeen: s.firstSeen }));

          let merged = [...query.cachedResults, ...newItems];
          merged.sort((a, b) => b.event.created_at - a.event.created_at);

          // Apply limit from filter
          const limit = query.filter.limit;
          if (limit && limit > 0) {
            merged = merged.slice(0, limit);
          }

          query.cachedResults = merged;
          query.subject.next(merged);
        }
      }
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
