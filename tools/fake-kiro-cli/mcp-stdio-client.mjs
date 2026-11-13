// A tiny MCP client over stdio (newline-delimited JSON-RPC), enough for the fake kiro-cli: start a
// server, handshake, call tools. No dependency, so the fake runs anywhere Node runs.
import { spawn } from 'node:child_process';

const STARTUP_MS = 8000;
const CALL_MS = 20000;

export class McpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.exited = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onData(chunk));
    child.stderr.on('data', () => undefined);
    child.on('exit', () => {
      this.exited = true;
      for (const { reject } of this.pending.values()) reject(new Error('mcp server exited'));
      this.pending.clear();
    });
    child.on('error', () => {
      this.exited = true;
      for (const { reject } of this.pending.values()) reject(new Error('mcp server failed to start'));
      this.pending.clear();
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let at;
    while ((at = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = this.pending.get(msg.id);
      if (!waiter) continue;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`rpc error ${msg.error.code}`));
      else waiter.resolve(msg.result);
    }
  }

  request(method, params, timeoutMs) {
    if (this.exited) return Promise.reject(new Error('mcp server exited'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params) {
    if (!this.exited) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async handshake() {
    await this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fake-kiro-cli', version: '0' } }, STARTUP_MS);
    this.notify('notifications/initialized', {});
  }

  async callTool(name, args) {
    const result = await this.request('tools/call', { name, arguments: args }, CALL_MS);
    return { text: result?.content?.[0]?.text ?? '', isError: result?.isError === true };
  }

  close() {
    try {
      this.child.stdin.end();
    } catch {
      // already closed
    }
    setTimeout(() => this.child.kill('SIGTERM'), 500).unref();
  }
}

/**
 * Starts the MCP server of an agent config like `kiro-cli` does: the command from `mcpServers`,
 * resolved on the PATH of this process, with this process' environment (minus `omit`).
 * Resolves with a handshaken client, or rejects when the server does not start.
 */
export async function startMcpServer(server, omit = []) {
  const env = { ...process.env };
  for (const name of omit) delete env[name];
  const child = spawn(server.command, server.args ?? [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const client = new McpClient(child);
  try {
    await client.handshake();
  } catch (err) {
    client.close();
    throw err;
  }
  return client;
}
