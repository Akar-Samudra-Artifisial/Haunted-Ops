import type { CueName } from './cues.js';

/** The master volume. */
export const MASTER_GAIN = 0.6;

/** Where each cue lives: same-origin files of `public/sfx/`, fetched only when the visitor turns sound on. */
export const CUE_FILES: Readonly<Record<CueName, string>> = {
  'ghost-appear': '/sfx/ghost-appear.mp3',
  possessed: '/sfx/possessed.mp3',
  'room-dark': '/sfx/room-dark.mp3',
  'calm-restored': '/sfx/calm-restored.mp3',
  'hunt-start': '/sfx/hunt-start.mp3',
  'hunt-step': '/sfx/hunt-step.mp3',
  diagnosed: '/sfx/diagnosed.mp3',
  'fix-merged': '/sfx/fix-merged.mp3',
};

export interface SoundPlayer {
  /** Plays one cue now, at `gain` times the master volume (1 unless given). Never throws. */
  play(cue: CueName, gain?: number): void;
  /** Resumes the audio context (after a click). */
  resume(): Promise<void>;
  /** The state of the audio context: cues play only while it is `running`. */
  state(): AudioContextState;
  close(): void;
}

export interface PlayerEnv {
  fetch?: typeof fetch;
}

/**
 * Starts the Web Audio player on the context the caller made: one master gain of 0.6, and the eight files fetched and decoded once (the buffers
 * are kept). The context is created and resumed by the caller inside the click (Safari drops the user activation while a chunk loads), never here.
 * This module is a lazy chunk: it is imported only when the visitor turns sound on. Rejects when a file fails, and the caller shows sound as unavailable.
 */
export async function createPlayer(ctx: AudioContext, env: PlayerEnv = {}): Promise<SoundPlayer> {
  const get = env.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(ctx.destination);
    const buffers = new Map<CueName, AudioBuffer>();
    await Promise.all(
      (Object.keys(CUE_FILES) as CueName[]).map(async (cue) => {
        const res = await get(CUE_FILES[cue]);
        if (!res.ok) throw new Error('file');
        buffers.set(cue, await ctx.decodeAudioData(await res.arrayBuffer()));
      }),
    );
    // Once more now the files are ready; a refusal leaves it suspended and `resume` tries again on the next click.
    void ctx.resume().catch(() => undefined);
    return {
      play(cue, gain = 1) {
        try {
          const buffer = buffers.get(cue);
          // A cue is skipped, not queued, while the context is not running (queued sources would all sound at once).
          if (buffer === undefined || ctx.state !== 'running') return;
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          if (gain === 1) source.connect(master);
          else {
            const level = ctx.createGain();
            level.gain.value = gain;
            source.connect(level);
            level.connect(master);
          }
          source.start();
        } catch {
          /* a cue that cannot play is skipped */
        }
      },
      async resume() {
        if (ctx.state === 'suspended') await ctx.resume();
      },
      state() {
        return ctx.state;
      },
      close() {
        void ctx.close().catch(() => undefined);
      },
    };
  } catch (error) {
    void ctx.close().catch(() => undefined);
    throw error;
  }
}
