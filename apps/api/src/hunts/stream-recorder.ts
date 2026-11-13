import { appendFile } from 'node:fs/promises';
import { redact } from '@haunted-ops/exorcist-mcp/untrusted';

/** A line longer than this is dropped, not kept. */
export const MAX_RECORDED_LINE = 64 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const pick = (source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (source[k] !== undefined) out[k] = source[k];
  return out;
};

/**
 * Reduces one line of the `kiro-cli` stream to what is needed to see its shapes and to build a fixture
 * from it: tool calls with their title and input, tool call updates without the tool output, the
 * Credits and turn reports, and the start and end of the run. The model's text, its thoughts and the
 * output of every tool are dropped. Secrets of this process are masked. Returns null for a line that
 * is not kept.
 */
export function reduceStreamLine(line: string, secrets: readonly string[]): string | null {
  if (line.length > MAX_RECORDED_LINE) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  let kept: Record<string, unknown> | null = null;
  if (value.type === 'runStarted') kept = { type: 'runStarted', data: isRecord(value.data) ? pick(value.data, ['payloadSchema', 'acpProtocolVersion', 'engine']) : {} };
  else if (value.type === 'runFinished') kept = { type: 'runFinished', data: isRecord(value.data) ? pick(value.data, ['status', 'stopReason']) : {} };
  else if (value.type === 'sessionUpdate' && isRecord(value.data) && isRecord(value.data.update)) {
    const u = value.data.update;
    let update: Record<string, unknown> | null = null;
    if (u.sessionUpdate === 'tool_call') update = pick(u, ['sessionUpdate', 'toolCallId', 'title', 'kind', 'rawInput', '_meta']);
    else if (u.sessionUpdate === 'tool_call_update') update = pick(u, ['sessionUpdate', 'toolCallId', 'status', 'title', 'kind', 'rawInput', '_meta']);
    else if (u.sessionUpdate === 'session_info_update') update = pick(u, ['sessionUpdate', '_meta']);
    if (update !== null) kept = { type: 'sessionUpdate', data: { sessionId: 'session-1', update } };
  }
  return kept === null ? null : redact(JSON.stringify(kept), secrets);
}

/**
 * Appends the reduced stream of one Hunt to a file (mode 0600), one JSON line per kept line. Writes
 * are queued in order and never throw; a failed write is dropped, because this is a debugging aid.
 */
export class StreamRecorder {
  private partial = '';
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly secrets: readonly string[],
    private readonly append: (path: string, text: string) => Promise<void> = (p, t) => appendFile(p, t, { encoding: 'utf8', mode: 0o600 }),
  ) {}

  write(chunk: string): void {
    this.partial += chunk;
    if (this.partial.length > 4 * MAX_RECORDED_LINE && !this.partial.includes('\n')) this.partial = '';
    let nl: number;
    let out = '';
    while ((nl = this.partial.indexOf('\n')) !== -1) {
      const kept = reduceStreamLine(this.partial.slice(0, nl), this.secrets);
      this.partial = this.partial.slice(nl + 1);
      if (kept !== null) out += `${kept}\n`;
    }
    if (out !== '') this.chain = this.chain.then(() => this.append(this.path, out)).catch(() => undefined);
  }

  /** Writes a last line that had no newline, and waits for every queued write. */
  async close(): Promise<void> {
    if (this.partial.trim() !== '') this.write('\n');
    this.partial = '';
    await this.chain;
  }
}
