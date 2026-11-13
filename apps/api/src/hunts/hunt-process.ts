import { spawn, type ChildProcess } from 'node:child_process';

/** Why this side stopped the process. A process that ends on its own has no stop reason. */
export type HuntStopReason = 'timeout' | 'foreign_tool' | 'credit_cap' | 'daily_cap' | 'tool_limit' | 'stream_error' | 'disabled' | 'shutdown';

export interface HuntExit {
  /** Exit code, or null when a signal ended the process. */
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The first reason `stop` was called with, or null. */
  stoppedBy: HuntStopReason | null;
  /** True when the process could not be started at all (a missing or non-executable file). */
  spawnFailed: boolean;
  stdoutBytes: number;
  stderrBytes: number;
}

export interface HuntProcessOptions {
  executable: string;
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string;
  timeoutMs: number;
  /** Most bytes of stdout read; more stops the Hunt with `stream_error`. */
  maxOutputBytes: number;
  /** Time between SIGTERM and SIGKILL. */
  killAfterMs?: number;
  onStdout: (chunk: string) => void;
}

export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const KILL_AFTER_MS = 2000;

/**
 * One `kiro-cli` child. It is started with an argument array and no shell, in its own process
 * group, with a fixed environment. `stop` is idempotent: SIGTERM to the group, SIGKILL after 2 s.
 * After the child closes, the whole group is sent SIGKILL once more so no grandchild (the MCP
 * server) survives. Stderr is drained and thrown away; only its size is kept.
 */
export class HuntProcess {
  readonly done: Promise<HuntExit>;
  private child: ChildProcess | null = null;
  private stoppedBy: HuntStopReason | null = null;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private spawnFailed = false;
  private timers: NodeJS.Timeout[] = [];
  private resolveDone!: (e: HuntExit) => void;
  private closed = false;

  constructor(private readonly opts: HuntProcessOptions) {
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  /** The process id, which is also the id of its process group (it is started detached). */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    if (this.child !== null || this.closed) return;
    // Stopped before it started (a shutdown while queued): nothing is spawned.
    if (this.stoppedBy !== null) {
      this.finish(null, null);
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(this.opts.executable, [...this.opts.argv], {
        cwd: this.opts.cwd,
        env: { ...this.opts.env },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch {
      this.spawnFailed = true;
      this.finish(null, null);
      return;
    }
    this.child = child;
    child.on('error', () => {
      // `spawn` reports a missing file here; there is then no 'close' with a code.
      if (child.pid === undefined) {
        this.spawnFailed = true;
        this.finish(null, null);
      }
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      this.stdoutBytes += Buffer.byteLength(chunk, 'utf8');
      if (this.stdoutBytes > this.opts.maxOutputBytes) {
        this.stop('stream_error');
        return;
      }
      // Once stopped, whatever else arrives is not read.
      if (this.stoppedBy === null) this.opts.onStdout(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrBytes += chunk.byteLength;
    });
    child.on('close', (code, signal) => this.finish(code, signal));
    this.timers.push(setTimeout(() => this.stop('timeout'), this.opts.timeoutMs));
  }

  /** Stops the process group. Safe to call at any time, any number of times. */
  stop(reason: HuntStopReason): void {
    if (this.stoppedBy === null) this.stoppedBy = reason;
    const child = this.child;
    if (child === null || child.pid === undefined || this.closed) return;
    if (this.timers.length > 1) return; // the SIGKILL timer is already armed
    this.signalGroup(child.pid, 'SIGTERM');
    this.timers.push(setTimeout(() => this.signalGroup(child.pid as number, 'SIGKILL'), this.opts.killAfterMs ?? KILL_AFTER_MS));
  }

  private signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch {
      // The group is already gone.
    }
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.child?.pid !== undefined) this.signalGroup(this.child.pid, 'SIGKILL');
    this.resolveDone({
      code,
      signal,
      stoppedBy: this.stoppedBy,
      spawnFailed: this.spawnFailed,
      stdoutBytes: this.stdoutBytes,
      stderrBytes: this.stderrBytes,
    });
  }
}
