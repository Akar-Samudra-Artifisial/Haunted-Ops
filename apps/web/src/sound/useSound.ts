import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServiceState } from '@haunted-ops/shared';
import { createCueGate, nextCue, type CueGate } from './cues.js';
import { readSoundOn, writeSoundOn } from './storage.js';
import type { SoundPlayer } from './player.js';

/** Loads the player chunk. The default is a dynamic import, so no audio code or file is fetched until sound is turned on. */
export type LoadPlayer = () => Promise<{ createPlayer: (ctx: AudioContext) => Promise<SoundPlayer> }>;
const loadPlayerChunk: LoadPlayer = () => import('./player.js');

/** Makes the one `AudioContext`, or null when the browser has none. */
export type MakeContext = () => AudioContext | null;
/**
 * Called synchronously inside the click (or the first click of a stored "on"), before the player chunk is asked for: the context is made (and
 * resumed by `start`) while the browser still counts the user activation (Safari drops it while a chunk loads). The rest stays in the lazy chunk.
 */
export const makeContext: MakeContext = () => {
  const Ctx = typeof AudioContext === 'function' ? AudioContext : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  try {
    return typeof Ctx === 'function' ? new Ctx() : null;
  } catch {
    return null;
  }
};

/** Sounds that stay quiet for this long show the hint, and the volume of the confirmation cue. */
export const SILENCE_HINT_MS = 20_000;
export const CONFIRM_GAIN = 0.5;

export interface SoundControl {
  /** The choice of the visitor: shown by the button. */
  on: boolean;
  /** The context could not start or a file failed: the button says so, stays clickable and tries again. */
  unavailable: boolean;
  /** Sound is on and no cue has played for 20 s: the button explains when sounds play. */
  hint: boolean;
  toggle: () => void;
}

export interface UseSoundOptions {
  /** False on the replay page: no sound there. */
  enabled?: boolean;
  loadPlayer?: LoadPlayer;
  makeContext?: MakeContext;
}

/**
 * Sound cues for the page. Off by default; the choice is kept in `localStorage`, but sound starts only after a click of this page load (the browser
 * blocks audio before one): turning it on loads the lazy player chunk and the eight files, and with a stored "on" the first click anywhere does it.
 * Every snapshot of `services` is compared with the last one (`nextCue`); the first one makes no sound.
 */
export function useSound(services: readonly ServiceState[], options: UseSoundOptions = {}): SoundControl {
  const { enabled = true, loadPlayer = loadPlayerChunk, makeContext: openContext = makeContext } = options;
  const [on, setOn] = useState<boolean>(() => readSoundOn());
  const [unavailable, setUnavailable] = useState(false);
  // The player exists: moves the listener of `resume` below (a ref does not re-render).
  const [ready, setReady] = useState(false);
  const player = useRef<SoundPlayer | null>(null);
  const starting = useRef(false);
  const gate = useRef<CueGate>(createCueGate());
  const live = useRef(true);
  const onRef = useRef(on);
  // The confirmation cue is owed: turning sound on (or retrying) asks for one, and it plays once the files are decoded.
  const confirm = useRef(false);
  // Moves on every cue and when sound is turned on: the 20 s of silence count from it; `hintFor` is the beat the hint was shown for.
  const [beat, setBeat] = useState(0);
  const [hintFor, setHintFor] = useState<number | null>(null);

  const start = useCallback((): void => {
    if (player.current !== null || starting.current) {
      void player.current?.resume();
      return;
    }
    starting.current = true;
    // Synchronous, inside the click: the context exists and is resumed before the chunk is asked for.
    const ctx = openContext();
    const fail = (): void => {
      starting.current = false;
      try {
        void ctx?.close().catch(() => undefined);
      } catch {
        /* nothing to close */
      }
      if (live.current) setUnavailable(true);
    };
    if (ctx === null) {
      fail();
      return;
    }
    try {
      void ctx.resume().catch(() => undefined);
    } catch {
      /* a context that cannot resume stays suspended; the next click tries again */
    }
    loadPlayer().then(
      (chunk) =>
        chunk.createPlayer(ctx).then((p) => {
          starting.current = false;
          if (!live.current) {
            p.close();
            return;
          }
          player.current = p;
          setReady(true);
          if (confirm.current && onRef.current) {
            confirm.current = false;
            // One soft cue now that the files are decoded, so the visitor hears at once that sound is on (the context was resumed in the click).
            p.play('hunt-step', CONFIRM_GAIN);
            setBeat((n) => n + 1);
          }
        }, fail),
      fail,
    );
  }, [loadPlayer, openContext]);

  useEffect(() => {
    onRef.current = on;
  }, [on]);

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
    if (ready && out.play !== null) {
      player.current?.play(out.play.cue);
      setBeat((n) => n + 1);
    }
  }, [services, enabled, on]);

  // Sound is on, the player runs and nothing has played for 20 s: the button says when sounds play. A cue (or turning sound on again) takes the hint away.
  useEffect(() => {
    if (!enabled || !on || !ready) return;
    const id = setTimeout(() => setHintFor(beat), SILENCE_HINT_MS);
    return () => clearTimeout(id);
  }, [enabled, on, ready, beat]);

  const toggle = useCallback((): void => {
    // "Sound unavailable" stays on and clickable: a click tries again with a new context.
    const next = unavailable ? true : !on;
    writeSoundOn(next);
    setOn(next);
    if (next) {
      setUnavailable(false);
      setBeat((n) => n + 1);
      const ready = player.current;
      if (ready !== null) {
        // On again with the files already decoded: confirm at once once the context runs.
        confirm.current = false;
        void ready.resume().then(() => ready.play('hunt-step', CONFIRM_GAIN), () => undefined);
        return;
      }
      confirm.current = true;
      start();
    } else confirm.current = false;
  }, [on, unavailable, start]);

  return { on, unavailable, hint: enabled && on && ready && !unavailable && hintFor === beat, toggle };
}
