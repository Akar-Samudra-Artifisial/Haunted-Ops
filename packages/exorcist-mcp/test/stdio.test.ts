import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUNT_TOOLS } from '@haunted-ops/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseLedger } from '../src/ledger.js';
import { startFakeBackends, TOKEN, type FakeHttp } from './fakes.js';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const shared = fileURLToPath(new URL('../../shared', import.meta.url));
const bin = join(pkg, 'bin', 'haunted-exorcist-mcp');
const tsc = join(pkg, '../../node_modules/.bin/tsc');
const ID = 'cmstdioaaaaaaaaaaaaaaaaaa';

let http: FakeHttp;
let dir: string;

beforeAll(async () => {
  // The launcher runs the built server, which imports the built shared package.
  execFileSync(tsc, ['-p', join(shared, 'tsconfig.build.json')], { stdio: 'ignore' });
  execFileSync(tsc, ['-p', join(pkg, 'tsconfig.build.json')], { stdio: 'ignore' });
  http = await startFakeBackends();
  dir = mkdtempSync(join(tmpdir(), 'exorcist-mcp-'));
  mkdirSync(join(dir, 'ledgers'));
}, 120_000);

afterAll(async () => {
  await http?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const env = (over: Record<string, string> = {}): Record<string, string> => ({
  PATH: process.env.PATH ?? '',
  LAB_URL: http.url,
  PROMETHEUS_URL: http.url,
  LAB_READ_TOKEN: TOKEN,
  HUNT_ID: ID,
  HUNT_LEDGER_PATH: join(dir, 'ledgers', `${ID}.jsonl`),
  ...over,
});

describe('the built server over stdio', () => {
  it('starts through the launcher, lists the six tools and writes the ledger', async () => {
    const transport = new StdioClientTransport({ command: bin, args: [], env: env(), stderr: 'pipe' });
    const client = new Client({ name: 'smoke', version: '0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...HUNT_TOOLS]);
    await client.callTool({ name: 'recent_deploys', arguments: { since: new Date(Date.now() - 3_600_000).toISOString() } });
    await client.close();
    const lines = parseLedger(readFileSync(join(dir, 'ledgers', `${ID}.jsonl`), 'utf8'));
    expect(lines.map((l) => (l.type === 'handle' ? l.handle : l.type))[0]).toBe('deploy:d-101');
  });

  it('exits 2 before the handshake on a bad environment, naming variables only', () => {
    let status = 0;
    let stderr = '';
    try {
      execFileSync(bin, [], { env: env({ LAB_READ_TOKEN: 'short-token', LAB_URL: 'http://10.0.0.8:4100' }), input: '', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      const e = err as { status: number; stderr: Buffer };
      status = e.status;
      stderr = e.stderr.toString();
    }
    expect(status).toBe(2);
    expect(stderr.trim()).toBe('invalid env: LAB_URL, LAB_READ_TOKEN');
    expect(stderr).not.toContain('short-token');
  });
});
