import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { logRequest, pathOnly, type JsonLogger } from './logger.js';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** Request with the id assigned by requestContext(). */
export type RequestWithId = IncomingMessage & { requestId?: string; originalUrl?: string };

export function requestIdOf(req: unknown): string {
  const id = (req as RequestWithId | undefined)?.requestId;
  return typeof id === 'string' ? id : 'unknown';
}

/**
 * Express-style middleware: assigns a fresh request id (client-supplied ids are
 * ignored), returns it in X-Request-Id and writes one JSON log line when the
 * response finishes or the client goes away.
 */
export function requestContext(logger: JsonLogger, now: () => number = () => performance.now()) {
  return (req: RequestWithId, res: ServerResponse, next: () => void): void => {
    const requestId = randomUUID();
    req.requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const started = now();
    let logged = false;
    const done = (): void => {
      if (logged) return;
      logged = true;
      logRequest(logger, {
        requestId,
        method: req.method ?? 'UNKNOWN',
        path: pathOnly(req.originalUrl ?? req.url ?? '/'),
        status: res.statusCode,
        durationMs: Math.round((now() - started) * 10) / 10,
      });
    };
    res.on('finish', done);
    res.on('close', done);
    next();
  };
}
