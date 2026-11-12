import type { NestExpressApplication } from '@nestjs/platform-express';

type CorsOptions = Exclude<Parameters<NestExpressApplication['enableCors']>[0], undefined | ((...args: never[]) => unknown)>;

/** Exact string match. No wildcard, no prefix or case folding. */
export function isAllowedOrigin(origin: unknown, configured: string): boolean {
  return typeof origin === 'string' && origin === configured;
}

/**
 * CORS for WEB_ORIGIN only. For any other origin the callback answers false,
 * so no Access-Control-Allow-* header is sent at all.
 */
export function corsOptions(webOrigin: string): CorsOptions {
  return {
    origin: (origin, callback) => {
      callback(null, isAllowedOrigin(origin, webOrigin));
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Last-Event-ID'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    credentials: false,
    maxAge: 600,
  };
}
