import { useEffect, useReducer } from 'react';
import type { ReplayFile } from '@haunted-ops/shared';
import { reducePlayer, startPlayer, type PlayerAction, type PlayerState } from './player.js';
/** How often the position moves while playing. Frames are at least a second apart, so this is fine enough. */
export const TICK_MS = 100;
/** The player of one file: the reducer, and a timer that ticks only while playing. */
export function useReplayPlayer(file: Pick<ReplayFile, 'frames' | 'durationMs'>, startPlaying: boolean): [PlayerState, (action: PlayerAction) => void] {
  const [state, dispatch] = useReducer((s: PlayerState, a: PlayerAction) => reducePlayer(file, s, a), startPlaying, startPlayer);
  const playing = state.playing;
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      dispatch({ type: 'tick', dtMs: now - last });
      last = now;
    }, TICK_MS);
    return () => clearInterval(id);
  }, [playing]);
  return [state, dispatch];
}
