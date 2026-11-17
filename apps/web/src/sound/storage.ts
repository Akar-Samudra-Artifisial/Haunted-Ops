import type { StorageLike } from '../a11y/storage.js';

/** The key of the sound choice, like the one of the mode switch (`haunted-ops.a11y.v1`). A new format gets a new key. */
export const SOUND_KEY = 'haunted-ops.sound.v1';

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** True only when the stored choice is exactly `{"sound":"on"}`. Total: a missing or throwing storage, bad JSON and a wrong shape all give false (sound is off by default). */
export function readSoundOn(storage?: StorageLike | null): boolean {
  try {
    const store = storage === undefined ? defaultStorage() : storage;
    if (store === null) return false;
    const raw = store.getItem(SOUND_KEY);
    if (typeof raw !== 'string') return false;
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { sound?: unknown }).sound === 'on';
  } catch {
    return false;
  }
}

/** Saves the choice; false when the browser refused. Never throws. */
export function writeSoundOn(on: boolean, storage?: StorageLike | null): boolean {
  try {
    const store = storage === undefined ? defaultStorage() : storage;
    if (store === null) return false;
    store.setItem(SOUND_KEY, JSON.stringify({ sound: on ? 'on' : 'off' }));
    return true;
  } catch {
    return false;
  }
}
