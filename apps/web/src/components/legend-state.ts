import type { StorageLike } from '../a11y/storage.js';
/** The key of the Legend choice: `open` or `closed`. */
export const LEGEND_KEY = 'haunted-ops:legend';
function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
/** Open when nothing is stored (a first visit), when 'open' is stored, or when the storage is missing or throws. */
export function readLegendOpen(storage?: StorageLike | null): boolean {
  try {
    const store = storage === undefined ? defaultStorage() : storage;
    if (store === null) return true;
    return store.getItem(LEGEND_KEY) !== 'closed';
  } catch {
    return true;
  }
}
/** Keeps the choice. Never throws. */
export function writeLegendOpen(open: boolean, storage?: StorageLike | null): void {
  try {
    const store = storage === undefined ? defaultStorage() : storage;
    store?.setItem(LEGEND_KEY, open ? 'open' : 'closed');
  } catch {
    // A storage that refuses is ignored; the Legend works without it.
  }
}
