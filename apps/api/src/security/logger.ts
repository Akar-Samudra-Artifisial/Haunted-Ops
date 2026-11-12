import type { LoggerService } from '@nestjs/common';
import { redact } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogSink = (line: string) => void;

const stdoutSink: LogSink = (line) => {
  process.stdout.write(line);
};

/**
 * Structured JSON logger: one line per entry, every entry passed through redact().
 * Callers pass explicit fields; nothing reads headers, bodies, query strings or env.
 */
export class JsonLogger {
  constructor(
    private readonly sink: LogSink = stdoutSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    const entry = redact({ ts: this.now().toISOString(), level, msg, ...fields });
    this.sink(`${JSON.stringify(entry)}\n`);
  }
}

/** Fields of the per-request log line. No other request data is logged. */
export interface RequestLogFields {
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

export const REQUEST_LOG_FIELDS = ['ts', 'level', 'msg', 'requestId', 'method', 'path', 'status', 'durationMs'] as const;

export function logRequest(logger: JsonLogger, fields: RequestLogFields): void {
  const level: LogLevel = fields.status >= 500 ? 'error' : fields.status >= 400 ? 'warn' : 'info';
  logger.log(level, 'request', { ...fields });
}

/** Strips the query string (and fragment) from a URL path. */
export function pathOnly(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** Routes Nest's own log calls into the JSON logger. Only the message text is kept. */
export class NestJsonLogger implements LoggerService {
  constructor(private readonly logger: JsonLogger) {}

  private text(message: unknown): string {
    return typeof message === 'string' ? message : message instanceof Error ? message.name : 'event';
  }

  log(message: unknown, context?: string): void {
    this.logger.log('info', this.text(message), context ? { context } : {});
  }
  error(message: unknown, _trace?: string, context?: string): void {
    // Traces are dropped on purpose: they can carry request data.
    this.logger.log('error', this.text(message), context ? { context } : {});
  }
  warn(message: unknown, context?: string): void {
    this.logger.log('warn', this.text(message), context ? { context } : {});
  }
  debug(message: unknown, context?: string): void {
    this.logger.log('debug', this.text(message), context ? { context } : {});
  }
  verbose(message: unknown, context?: string): void {
    this.logger.log('debug', this.text(message), context ? { context } : {});
  }
}
