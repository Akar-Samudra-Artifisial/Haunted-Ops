import { Catch, HttpException, HttpStatus, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import type { JsonLogger } from './logger.js';
import { requestIdOf } from './request-context.js';

const CODES: Readonly<Record<number, string>> = {
  400: 'bad_request',
  404: 'not_found',
  405: 'method_not_allowed',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
  503: 'unavailable',
};

/** Status of an error from Nest or from body-parser (`status` / `statusCode`). */
export function statusOf(err: unknown): number {
  if (err instanceof HttpException) return err.getStatus();
  if (typeof err === 'object' && err !== null) {
    const s = (err as { status?: unknown; statusCode?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
    if (typeof s === 'number' && Number.isInteger(s) && s >= 400 && s < 500) return s;
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

export function errorCode(status: number): string {
  return CODES[status] ?? (status >= 500 ? 'internal' : 'error');
}

/**
 * Turns every error into `{ error, requestId }`. Stack traces and internal
 * messages never reach the client; 5xx are logged with the error class name only.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: JsonLogger) {}

  catch(err: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<unknown>();
    const res = ctx.getResponse<ServerResponse>();
    const status = statusOf(err);
    const requestId = requestIdOf(req);

    if (status >= 500) {
      const errorClass = err instanceof Error ? err.constructor.name : typeof err;
      this.logger.log('error', 'unhandled error', { requestId, errorClass });
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: errorCode(status), requestId }));
  }
}
