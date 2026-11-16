import { applyReplayFrame, type ReplayFile, type ReplayState } from '@haunted-ops/shared';
/** The frame player. Pure: the position in milliseconds is the whole state of time; the shown state is a fold of frames. */
export const SPEEDS = [1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];
export interface PlayerState {
  /** Milliseconds from the start, 0 to `durationMs`. */
  position: number;
  playing: boolean;
  speed: Speed;
}
export type PlayerAction =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'toggle' }
  | { type: 'speed'; speed: Speed }
  | { type: 'tick'; dtMs: number }
  | { type: 'seek'; ms: number }
  | { type: 'next' }
  | { type: 'prev' };
type Timed = Pick<ReplayFile, 'frames' | 'durationMs'>;
export const startPlayer = (playing: boolean): PlayerState => ({ position: 0, playing, speed: 1 });
/** Index of the last frame with `t <= position` (frame 0 has `t` 0, so there always is one). */
export function frameIndexAt(frames: ReplayFile['frames'], position: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((frames[mid] as { t: number }).t <= position) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
/** The state after each frame: `states[i]` is the fold of frames 0 to i. Parts a frame does not name are shared, not copied. */
export function timeline(frames: ReplayFile['frames']): ReplayState[] {
  const out: ReplayState[] = [];
  let state: ReplayState = { services: [], hunt: null, proposal: null };
  for (const frame of frames) {
    state = applyReplayFrame(state, frame);
    out.push(state);
  }
  return out;
}
/** The state at `position`: the fold of the frames up to it. */
export function stateAt(states: readonly ReplayState[], frames: ReplayFile['frames'], position: number): ReplayState {
  return states[frameIndexAt(frames, position)] as ReplayState;
}
const clamp = (ms: number, file: Timed): number => Math.min(file.durationMs, Math.max(0, Math.round(ms)));
export function reducePlayer(file: Timed, state: PlayerState, action: PlayerAction): PlayerState {
  const idx = frameIndexAt(file.frames, state.position);
  const here = (file.frames[idx] as { t: number }).t;
  switch (action.type) {
    case 'play':
      // Play at the end starts again from the beginning.
      return { ...state, playing: true, position: state.position >= file.durationMs ? 0 : state.position };
    case 'pause':
      return { ...state, playing: false };
    case 'toggle':
      return reducePlayer(file, state, { type: state.playing ? 'pause' : 'play' });
    case 'speed':
      return { ...state, speed: action.speed };
    case 'tick': {
      if (!state.playing) return state;
      const position = clamp(state.position + action.dtMs * state.speed, file);
      return position >= file.durationMs ? { ...state, position: file.durationMs, playing: false } : { ...state, position };
    }
    case 'seek':
      return { ...state, position: clamp(action.ms, file) };
    case 'next': {
      const next = file.frames[idx + 1];
      return { ...state, playing: false, position: next === undefined ? state.position : next.t };
    }
    case 'prev': {
      if (state.position > here) return { ...state, playing: false, position: here };
      const before = file.frames[idx - 1];
      return { ...state, playing: false, position: before === undefined ? 0 : before.t };
    }
  }
}
/** "1 min 20 s", "3 min", "20 s": a position as words, for `aria-valuetext`. */
export function spoken(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return [m > 0 ? `${m} min` : '', s > 0 || m === 0 ? `${s} s` : ''].filter(Boolean).join(' ');
}
export const positionText = (position: number, durationMs: number): string => `${spoken(position)} of ${spoken(durationMs)}`;
/** The banner and the table caption: the date is the recording date, never the time of the recording. */
export const bannerText = (recordedOn: string): string => `Replay of ${recordedOn}, not live`;
/** The wall-clock time the scene reads as "now" for a position: midnight of the recording date plus the position, to the second. */
export const sceneClock = (recordedOn: string, position: number): number => Date.parse(`${recordedOn}T00:00:00.000Z`) + Math.floor(position / 1000) * 1000;
