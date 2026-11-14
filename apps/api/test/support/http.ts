import { All, Body, Controller, Get, Module, Post, type ModuleMetadata } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, type CreateAppOptions, type HttpTimeouts } from '../../src/app.js';
import { parseConfig, type Config } from '../../src/config/config.js';
import type { HuntConfig } from '../../src/hunts/hunt-config.js';
import { JsonLogger } from '../../src/security/logger.js';

export const TEST_ORIGIN = 'http://localhost:5173';

/** Test-only routes, mounted only by tests. */
@Controller('__test')
class TestRoutesController {
  @Post('echo')
  echo(@Body() body: unknown): { ok: true; size: number } {
    return { ok: true, size: JSON.stringify(body ?? null).length };
  }

  @Get('boom')
  boom(): never {
    throw new Error('internal detail: connection to db-secret-host failed');
  }

  @All('any')
  any(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [TestRoutesController] })
export class TestRoutesModule {}

export interface TestServer {
  app: NestExpressApplication;
  url: string;
  config: Config;
  logs: string[];
  close: () => Promise<void>;
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return parseConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgresql://app@127.0.0.1:1/unused',
    PORT: '3000',
    WEB_ORIGIN: TEST_ORIGIN,
    ...overrides,
  });
}

/** Starts the app on an ephemeral port, capturing log lines. */
export async function startServer(
  options: {
    config?: Config;
    imports?: ModuleMetadata['imports'];
    init?: (app: NestExpressApplication) => void;
    timeouts?: HttpTimeouts;
    huntConfig?: HuntConfig;
    fixConfig?: CreateAppOptions['fixConfig'];
    fixOverrides?: CreateAppOptions['fixOverrides'];
  } = {},
): Promise<TestServer> {
  const logs: string[] = [];
  const config = options.config ?? testConfig();
  const app = await createApp(config, {
    logger: new JsonLogger((line) => logs.push(line)),
    imports: [TestRoutesModule, ...(options.imports ?? [])],
    timeouts: options.timeouts,
    huntConfig: options.huntConfig,
    fixConfig: options.fixConfig,
    fixOverrides: options.fixOverrides,
  });
  options.init?.(app);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return {
    app,
    url: `http://127.0.0.1:${port}`,
    config,
    logs,
    close: async () => {
      // A stream a failed test left open would hold `close` until Node's 300 s request timeout and hide the
      // real failure behind a timeout. After a short grace for a clean shutdown, the connections are cut.
      const http = app.getHttpServer() as Server;
      const force = setTimeout(() => http.closeAllConnections(), CLOSE_GRACE_MS);
      try {
        await app.close();
      } finally {
        clearTimeout(force);
      }
    },
  };
}

/** How long `close` waits for open connections before it cuts them. */
const CLOSE_GRACE_MS = 1_000;

export function parsedLogs(logs: readonly string[]): Record<string, unknown>[] {
  return logs.map((l) => JSON.parse(l) as Record<string, unknown>);
}
