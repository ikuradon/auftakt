export interface NegativeCache {
  has(eventId: string): boolean;
  set(eventId: string, ttlMs: number): void;
  delete(eventId: string): void;
}

export function createNegativeCache(): NegativeCache {
  const entries = new Map<string, number>(); // eventId → expiresAt (Date.now based)

  return {
    has(eventId: string): boolean {
      const expiresAt = entries.get(eventId);
      if (expiresAt === undefined) return false;
      if (Date.now() >= expiresAt) {
        entries.delete(eventId);
        return false;
      }
      return true;
    },

    set(eventId: string, ttlMs: number): void {
      entries.set(eventId, Date.now() + ttlMs);
      if (entries.size > 10000) {
        const now = Date.now();
        for (const [id, expiresAt] of entries) {
          if (expiresAt <= now) entries.delete(id);
        }
      }
    },

    delete(eventId: string): void {
      entries.delete(eventId);
    },
  };
}
