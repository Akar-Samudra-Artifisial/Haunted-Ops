import type { JsonLogger } from '../security/logger.js';
import type { IngestService } from './ingest.service.js';
import { PollError, type PollErrorCode, type PrometheusClient } from './prometheus-client.js';

export interface PollerDeps {
  client: PrometheusClient;
  ingest: Pick<IngestService, 'applyPoll' | 'pollFailed'>;
  intervalMs: number;
  logger: JsonLogger;
  now?: () => Date;
}

/**
 * Runs one Poll at start and then one per interval. A tick that finds a Poll still running does
 * nothing, so never two Polls are in flight. A failed Poll is handed to the ingest service and
 * never escapes: the Poller does not crash and does not stop.
 */
export class Poller {
  private readonly deps: PollerDeps;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private current: Promise<void> | null = null;
  private stopped = false;
  private readonly shutdown = new AbortController();

  constructor(deps: PollerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  get running(): boolean {
    return this.current !== null;
  }

  start(): void {
    if (this.timer !== null || this.stopped) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.deps.intervalMs);
    this.timer.unref?.();
  }

  /** Clears the timer, aborts a request in flight, and waits for the Poll that is running. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.shutdown.abort();
    if (this.current !== null) await this.current;
  }

  /** Starts a Poll unless one is running or the Poller is stopped. Returns true if it started one. */
  tick(): boolean {
    if (this.stopped || this.current !== null) return false;
    this.current = this.poll().finally(() => {
      this.current = null;
    });
    return true;
  }

  private async poll(): Promise<void> {
    let result;
    try {
      result = await this.deps.client.poll(this.shutdown.signal);
    } catch (err) {
      if (this.stopped) return;
      let code: PollErrorCode = 'network';
      if (err instanceof PollError) code = err.code;
      else this.deps.logger.log('error', 'poll_error', { error: err instanceof Error ? err.name : 'unknown' });
      this.deps.ingest.pollFailed(this.now(), code);
      return;
    }
    try {
      await this.deps.ingest.applyPoll(this.now(), result);
    } catch (err) {
      this.deps.logger.log('error', 'ingest_error', { error: err instanceof Error ? err.name : 'unknown' });
    }
  }
}
