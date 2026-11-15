import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { formatConfigError, parseMcpConfig } from './config.js';
import { HandleRegistry } from './handles.js';
import { LabClient } from './lab-client.js';
import { FileSink, Ledger } from './ledger.js';
import { PromClient } from './prom-client.js';
import { createExorcistServer } from './server.js';

/**
 * Entry point, started by kiro-cli once per Hunt through `bin/haunted-exorcist-mcp`. Stdout is
 * the MCP channel; diagnostics go to stderr and never carry an environment value.
 */
async function main(): Promise<void> {
  const parsed = parseMcpConfig(process.env);
  if (!parsed.ok) {
    process.stderr.write(`${formatConfigError(parsed.names)}\n`);
    process.exit(2);
  }
  const cfg = parsed.config;
  const ledger = new Ledger(new FileSink(cfg.ledgerPath));
  const handles = new HandleRegistry((issued) => ledger.handle(issued));
  const server = createExorcistServer({
    lab: new LabClient(cfg.labUrl, cfg.labToken),
    prom: new PromClient(cfg.promUrl),
    handles,
    ledger,
    now: Date.now,
    // The Kiro API key reaches this process when the Hunt has one (kiro-cli passes its environment on); it is masked like the lab token.
    secrets: [cfg.labToken, ...(process.env.KIRO_API_KEY ? [process.env.KIRO_API_KEY] : [])],
  });
  await server.connect(new StdioServerTransport());
}

main().catch(() => {
  process.stderr.write('exorcist-mcp: fatal error\n');
  process.exit(1);
});
