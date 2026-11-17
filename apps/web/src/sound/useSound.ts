import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServiceState } from '@haunted-ops/shared';
import { createCueGate, nextCue, type CueGate } from './cues.js';
import { readSoundOn, writeSoundOn } from './storage.js';
import type { SoundPlayer } from './player.js';

/** Loads the player chunk. The default is a dynamic import, so no audio code or file is fetched until sound is turned on. */
export type LoadPlayer = () => Promise<{ createPlayer: () => Promise<SoundPlayer> }>;
const loadPlayerChunk: LoadPlayer = () => import('./player.js');

export interface SoundControl {
  /** The choice of the visitor: shown by the button. */
  on: boolean;
  /** The context could not start or a file failed: the button says so and the app goes on. */
  unavailable: boolean;
  toggle: () => void;
}

export interface UseSoundOptions {
  /** False on the replay page: no sound there. */
  enabled?: boolean;
  loadPlayer?: LoadPlayer;
}

/**
 * Sound cues for the page. Off by default; the choice is kept in `localStorage`, but sound starts only after a click of this page load (the browser
 * blocks audio before one): turning it on loads the lazy player chunk and the eight files, and with a stored "on" the first click anywhere does it.
 * Every snapshot of `services` is compared with the last one (`nextCue`); the first one makes no sound.
 */
export function useSound(services: readonly ServiceState[], options: UseSoundOptions = {}): SoundControl {
  const { enabled = true, loadPlayer = loadPlayerChunk } = options;
  const [on, setOn] = useState<boolean>(() => readSoundOn());
  const [unavailable, setUnavailable] = useState(false);
  // The player exists: moves the listener of `resume` below (a ref does not re-render).
  const [ready, setReady] = useState(false);
  const player = useRef<SoundPlayer | null>(null);
  const starting = useRef(false);
  const gate = useRef<CueGate>(createCueGate());
  const live = useRef(true);

  const start = useCallback((): void => {
    if (player.current !== null || starting.current) {
      void player.current?.resume();
      return;
    }
    starting.current = true;
    loadPlayer().then(
      (chunk) =>
        chunk.createPlayer().then(
          (p) => {
            starting.current = false;
            if (!live.current) {
              p.close();
              return;
            }
            player.current = p;
            setReady(true);
          },
          () => {
            starting.current = false;
            if (live.current) setUnavailable(true);
          },
        ),
      () => {
        starting.current = false;
        if (live.current) setUnavailable(true);
      },
    );
  }, [loadPlayer]);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      player.current?.close();
      player.current = null;
    };
  }, []);

  // A stored "on" starts at the first user activation of the page (pointerdown, click, Enter or Space; a Tab key press is none); nothing is loaded before.
  useEffect(() => {
    if (!enabled || !on || player.current !== null || starting.current) return;
    const events = ['pointerdown', 'click', 'keydown'] as const;
    const detach = (): void => {
      for (const name of events) document.removeEventListener(name, go, { capture: true });
    };
    function go(e: Event): void {
      if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Enter' && (e as KeyboardEvent).key !== ' ') return;
      detach();
      start();
    }
    for (const name of events) document.addEventListener(name, go, { capture: true });
    return detach;
  }, [enabled, on, start]);

  // While sound is on and the player is not running (the browser refused, or paused it), the next pointerdown or click resumes it; the listeners go once it runs.
  useEffect(() => {
    const p = player.current;
    if (!enabled || !on || !ready || p === null || p.state() === 'running') return;
    const events = ['pointerdown', 'click'] as const;
    const detach = (): void => {
      for (const name of events) document.removeEventListener(name, wake, { capture: true });
    };
    function wake(): void {
      void p!.resume().then(
        () => {
          if (p!.state() === 'running') detach();
        },
        () => undefined,
      );
    }
    for (const name of events) document.addEventListener(name, wake, { capture: true });
    return detach;
  }, [enabled, on, ready]);

  // Every snapshot is compared with the last; a cue plays only when sound is on and the player is ready.
  useEffect(() => {
    if (!enabled) return;
    const out = nextCue(gate.current, services, Date.now());
    const ready = on && player.current !== null;
    // A cue that is not heard (sound off, player not ready) does not count against the rate limits; only the state to compare with moves on.
    gate.current = ready ? out.gate : { ...gate.current, prev: services };
    if (ready && out.play !== null) player.current?.play(out.play.cue);
  }, [services, enabled, on]);

  const toggle = useCallback((): void => {
    const next = !on;
    writeSoundOn(next);
    setOn(next);
    if (next) {
      setUnavailable(false);
      void player.current?.resume().catch(() => undefined);
      start();
    }
  }, [on, start]);

  return { on, unavailable, toggle };
}
