import type { NostrEvent, NostrFilter } from '../types.js';

export function matchesFilter(event: NostrEvent, filter: NostrFilter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;

  for (const key of Object.keys(filter)) {
    if (!key.startsWith('#')) continue;
    const tagName = key.slice(1);
    const requiredValues = filter[key as `#${string}`];
    if (!requiredValues || requiredValues.length === 0) continue;

    const eventTagValues = event.tags
      .filter(t => t[0] === tagName)
      .map(t => t[1]);

    const hasMatch = requiredValues.some(v => eventTagValues.includes(v));
    if (!hasMatch) return false;
  }

  return true;
}
