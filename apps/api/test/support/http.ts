import { All, Body, Controller, Get, Module, Post, type ModuleMetadata } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { createApp, type HttpTimeouts } from '../../src/app.js';
import { parseConfig, type Config } from '../../src/config/config.js';
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
  } = {},
): Promise<TestServer> {
  const logs: string[] = [];
  const config = options.config ?? testConfig();
  const app = await createApp(config, {
    logger: new JsonLogger((line) => logs.push(line)),
    imports: [TestRoutesModule, ...(options.imports ?? [])],
    timeouts: options.timeouts,
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
      await app.close();
    },
  };
}

export function parsedLogs(logs: readonly string[]): Record<string, unknown>[] {
  return logs.map((l) => JSON.parse(l) as Record<string, unknown>);
}
