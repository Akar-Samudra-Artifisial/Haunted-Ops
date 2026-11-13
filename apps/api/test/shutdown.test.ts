import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IngestRunner } from '../src/ingest/ingest.runner.js';
import { IngestService } from '../src/ingest/ingest.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { startServer, testConfig, type TestServer } from './support/http.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const until = async (check: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
};

describe('shutdown order', () => {
  let stub: Server | undefined;
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close().catch(() => undefined);
    await new Promise<void>((r) => (stub ? stub.close(() => r()) : r()));
    stub = undefined;
    server = undefined;
  });

  async function boot(stubDelayMs: number) {
    let requests = 0;
    stub = createServer((_req, res) => {
      requests += 1;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [] } }));
      }, stubDelayMs);
    });
    await new Promise<void>((r) => stub!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
    server = await startServer({ config: testConfig({ PROMETHEUS_URL: url }) });
    const order: string[] = [];
    const prisma = server.app.get(PrismaService);
    vi.spyOn(prisma.client, '$disconnect').mockImplementation(() => {
      order.push('disconnect');
      return Promise.resolve();
    });
    const ingest = server.app.get(IngestService);
    vi.spyOn(ingest, 'applyPoll').mockImplementation(async () => {
      order.push('apply-start');
      await sleep(200);
      order.push('apply-end');
    });
    return { order, runner: server.app.get(IngestRunner), requests: () => requests };
  }

  it('waits for a Poll that is being applied, and only then disconnects', async () => {
    const { order, runner } = await boot(0);
    runner.start();
    await until(() => order.includes('apply-start'), 'the poll to be applied');
    await server!.close();
    expect(order).toEqual(['apply-start', 'apply-end', 'disconnect']);
  });

  it('aborts a request in flight, applies nothing, and disconnects', async () => {
    const { order, runner, requests } = await boot(1500);
    runner.start();
    await until(() => requests() > 0, 'the request to reach Prometheus');
    await server!.close();
    expect(order).toEqual(['disconnect']);
  });

  it('keeps the disconnect out of the module-destroy phase', () => {
    expect(PrismaService.prototype).not.toHaveProperty('onModuleDestroy');
    expect(PrismaService.prototype).toHaveProperty('onApplicationShutdown');
    expect(IngestRunner.prototype).toHaveProperty('onModuleDestroy');
  });
});
