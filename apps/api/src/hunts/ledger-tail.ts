import { parseLedger, type LedgerLine } from '@haunted-ops/exorcist-mcp/ledger';

export const LEDGER_POLL_MS = 200;
/** A ledger larger than this is read only up to here; the MCP server writes a few KiB. */
export const MAX_LEDGER_CHARS = 1024 * 1024;

export type HandleLine = Extract<LedgerLine, { type: 'handle' }>;

export interface LedgerTailOptions {
  read: () => Promise<string>;
  onHandle: (line: HandleLine) => void | Promise<void>;
  intervalMs?: number;
}

/**
 * Follows the Hunt ledger. It polls the file, parses it (bad lines are ignored) and hands each new
 * handle line, in order and once, to `onHandle`. `stop()` reads one last time, so a handle written
 * just before the process exited is not lost.
 */
export class LedgerTail {
  private seen = 0;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private chain: Promise<void> = Promise.resolve();
  private latest: LedgerLine[] = [];

  constructor(private readonly opts: LedgerTailOptions) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.poll(), this.opts.intervalMs ?? LEDGER_POLL_MS);
    this.timer.unref();
  }

  /** The lines of the last read. */
  get lines(): readonly LedgerLine[] {
    return this.latest;
  }

  /** Polls once. Calls are serialized, so `onHandle` never runs twice at the same time. */
  poll(): Promise<void> {
    this.chain = this.chain.then(() => this.readOnce());
    return this.chain;
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.poll();
  }

  private async readOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let text = '';
      try {
        text = await this.opts.read();
      } catch {
        return;
      }
      const lines = parseLedger(text.length > MAX_LEDGER_CHARS ? text.slice(0, MAX_LEDGER_CHARS) : text);
      this.latest = lines;
      const fresh = lines.filter((l): l is HandleLine => l.type === 'handle' && l.seq > this.seen);
      for (const line of fresh) {
        this.seen = Math.max(this.seen, line.seq);
        await this.opts.onHandle(line);
      }
    } finally {
      this.running = false;
    }
  }
}
