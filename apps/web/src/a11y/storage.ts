import { STORAGE_KEY, parseSavedChoice, serializeChoice, type SavedChoice } from './mode.js';
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
/** `localStorage`, or null when the browser has none or refuses access (private mode, blocked storage). */
function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
/** The saved choice. Total: a missing or throwing storage, bad JSON and a wrong shape all give null. */
export function readSavedChoice(storage?: StorageLike | null): SavedChoice {
  try {
    const store = storage === undefined ? defaultStorage() : storage;
    if (store === null) return null;
    return parseSavedChoice(store.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}
/** Saves the choice; false when the browser refused. Never throws. */
export function writeSavedChoice(choice: 'on' | 'off', storage?: StorageLike | null): boolean {
  try {
    const store = storage === undefined ? defaultStorage() : storage;
    if (store === null) return false;
    store.setItem(STORAGE_KEY, serializeChoice(choice));
    return true;
  } catch {
    return false;
  }
}
