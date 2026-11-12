import 'reflect-metadata';
import type { Server } from 'node:http';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule, type AppModuleOptions } from './app.module.js';
import type { Config } from './config/config.js';
import { corsOptions } from './security/cors.js';
import { ErrorFilter } from './security/error.filter.js';
import { JsonLogger, NestJsonLogger } from './security/logger.js';
import { requestContext } from './security/request-context.js';

export const JSON_BODY_LIMIT = '32kb';

/** Time to receive a whole request (headers and body). Responses, including SSE streams, are not limited by it. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** Time to receive the request headers. Must not exceed REQUEST_TIMEOUT_MS. */
export const HEADERS_TIMEOUT_MS = 15_000;
export const KEEP_ALIVE_TIMEOUT_MS = 5_000;

export interface HttpTimeouts {
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  keepAliveTimeoutMs: number;
}

export const DEFAULT_TIMEOUTS: HttpTimeouts = {
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  headersTimeoutMs: HEADERS_TIMEOUT_MS,
  keepAliveTimeoutMs: KEEP_ALIVE_TIMEOUT_MS,
};

/**
 * Sets the Node HTTP server timeouts explicitly. `requestTimeout` and
 * `headersTimeout` bound how long a client may take to *send* a request, so
 * slow-loris clients are cut off; an SSE response is long-lived and unaffected.
 * The socket inactivity timeout stays off; the SSE route also disables it per socket.
 */
export function configureHttpServer(server: Server, timeouts: HttpTimeouts = DEFAULT_TIMEOUTS): void {
  server.requestTimeout = timeouts.requestTimeoutMs;
  server.headersTimeout = Math.min(timeouts.headersTimeoutMs, timeouts.requestTimeoutMs);
  server.keepAliveTimeout = timeouts.keepAliveTimeoutMs;
  server.timeout = 0;
}

export interface CreateAppOptions {
  logger?: JsonLogger;
  imports?: AppModuleOptions['imports'];
  timeouts?: HttpTimeouts;
}

/**
 * Builds the Nest app with the security baseline, without listening.
 * Order: request id + log line, security headers, CORS, JSON body limit,
 * then guards (rate limit), routes and the error filter.
 */
export async function createApp(config: Config, options: CreateAppOptions = {}): Promise<NestExpressApplication> {
  const logger = options.logger ?? new JsonLogger();
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot({ config, logger, imports: options.imports }),
    { bodyParser: false, logger: new NestJsonLogger(logger), abortOnError: false },
  );

  app.disable('x-powered-by');
  // A hop count, never `true`: only that many proxies may set X-Forwarded-For. 0 trusts none.
  // req.ip (used by the throttler and the per-IP SSE cap) follows this setting.
  app.set('trust proxy', config.trustProxyHops);
  app.use(requestContext(logger));
  app.use(helmet());
  app.enableCors(corsOptions(config.webOrigin));
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.useGlobalFilters(new ErrorFilter(logger));
  app.enableShutdownHooks();
  configureHttpServer(app.getHttpServer() as Server, options.timeouts);
  return app;
}
