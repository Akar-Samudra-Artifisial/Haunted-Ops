export type Quality = 'full' | 'low';

export interface GovernorOptions {
  /** Average frame time above this for `highForMs` switches to low power. */
  highMs?: number;
  /** Average frame time below this for `lowForMs` switches back. */
  lowMs?: number;
  highForMs?: number;
  lowForMs?: number;
  /** Frames are averaged in blocks of this many milliseconds. */
  blockMs?: number;
}

/**
 * Switches to low power quality when the frame time stays high for 2 s, and back only after a
 * sustained good period of 10 s. Frames are averaged in blocks, so one slow frame does nothing.
 */
export class PerfGovernor {
  private readonly highMs: number;
  private readonly lowMs: number;
  private readonly highBlocks: number;
  private readonly lowBlocks: number;
  private readonly blockMs: number;
  private mode: Quality = 'full';
  private sum = 0;
  private count = 0;
  private elapsed = 0;
  private highRun = 0;
  private lowRun = 0;

  constructor(options: GovernorOptions = {}) {
    this.highMs = options.highMs ?? 20;
    this.lowMs = options.lowMs ?? 14;
    this.blockMs = options.blockMs ?? 500;
    this.highBlocks = Math.ceil((options.highForMs ?? 2000) / this.blockMs);
    this.lowBlocks = Math.ceil((options.lowForMs ?? 10_000) / this.blockMs);
  }

  get quality(): Quality {
    return this.mode;
  }

  /** Feed the time of one frame in milliseconds. Returns the quality to use. */
  push(frameMs: number): Quality {
    this.sum += frameMs;
    this.count += 1;
    this.elapsed += frameMs;
    if (this.elapsed < this.blockMs) return this.mode;
    const average = this.sum / this.count;
    this.sum = 0;
    this.count = 0;
    this.elapsed = 0;
    this.highRun = average > this.highMs ? this.highRun + 1 : 0;
    this.lowRun = average < this.lowMs ? this.lowRun + 1 : 0;
    if (this.mode === 'full' && this.highRun >= this.highBlocks) {
      this.mode = 'low';
      this.highRun = 0;
      this.lowRun = 0;
    } else if (this.mode === 'low' && this.lowRun >= this.lowBlocks) {
      this.mode = 'full';
      this.highRun = 0;
      this.lowRun = 0;
    }
    return this.mode;
  }
}
