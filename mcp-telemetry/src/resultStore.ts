// In-memory store for full tool results. Tools return a short summary plus the
// result_id; the full result stays here for later lookup. Process-local, bounded.

import { randomUUID } from "node:crypto";

export interface ResultStoreOptions {
  /** Oldest entries are evicted beyond this. */
  maxEntries?: number;
  /** Source of the 8-hex suffix; injectable so tests can force collisions. */
  newSuffix?: () => string;
}

const DEFAULT_MAX_ENTRIES = 500;
const MAX_ID_ATTEMPTS = 10;
const PREFIX = /^[a-z]{1,8}$/;

export class ResultStore {
  private readonly entries = new Map<string, unknown>();
  private readonly maxEntries: number;
  private readonly newSuffix: () => string;

  constructor(opts: ResultStoreOptions = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.newSuffix = opts.newSuffix ?? (() => randomUUID().replaceAll("-", "").slice(0, 8));
  }

  get size(): number {
    return this.entries.size;
  }

  put(prefix: string, value: unknown): string {
    if (!PREFIX.test(prefix)) throw new Error(`result id prefix must match ${PREFIX}, got ${prefix}`);
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = `${prefix}_${this.newSuffix()}`;
      if (this.entries.has(id)) continue;
      this.entries.set(id, value);
      // Map iterates in insertion order, so the first key is the oldest.
      while (this.entries.size > this.maxEntries) {
        const oldest = this.entries.keys().next();
        if (oldest.done) break;
        this.entries.delete(oldest.value);
      }
      return id;
    }
    throw new Error(`could not find a free result id after ${MAX_ID_ATTEMPTS} attempts`);
  }

  get(id: string): unknown {
    return this.entries.get(id);
  }
}
