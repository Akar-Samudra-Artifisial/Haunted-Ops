/**
 * Parser of the `kiro-cli --output-format stream-json` output. The shapes were confirmed on
 * `kiro-cli` 3.3.0 (see the design, "Stream events"). The stream carries the model's text, its
 * thoughts and the full output of every tool: none of that is ever kept. Only the fields below are.
 */

export type HuntStreamEvent =
  | { type: 'tool_call'; id: string; title: string; rawInput: unknown }
  /** `title` is null when the update has none (kiro-cli 3.3.0 sends `title: null` while a call runs); `rawInput` is only what the update itself carries. */
  | { type: 'tool_call_update'; id: string; status: string; title?: string | null; rawInput?: unknown }
  /** The sum of `credits[i].usage` of one report. */
  | { type: 'credits'; usage: number }
  | { type: 'turn'; elapsedMs: number | null; stopReason: string | null }
  | { type: 'run_finished'; status: string }
  /** Any other valid JSON line (messages, thoughts, context usage, options). */
  | { type: 'ignored' }
  /** Not JSON, not an object, or longer than the line limit. */
  | { type: 'malformed' };

/** The longest line the parser keeps. A longer one is `malformed` and skipped to its end. */
export const MAX_LINE_BYTES = 1024 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.slice(0, max) : '');

function creditsOf(kiro: Record<string, unknown>): number | null {
  if (!Array.isArray(kiro.credits)) return null;
  let sum = 0;
  for (const c of kiro.credits) {
    const usage = isRecord(c) ? c.usage : undefined;
    if (typeof usage === 'number' && Number.isFinite(usage) && usage >= 0) sum += usage;
  }
  return sum;
}

/** Turns one JSON value into an event. Total: any value gives an event. */
export function classify(value: unknown): HuntStreamEvent {
  if (!isRecord(value)) return { type: 'malformed' };
  if (value.type === 'runFinished') {
    const data = isRecord(value.data) ? value.data : {};
    return { type: 'run_finished', status: str(data.status, 40) || 'unknown' };
  }
  const update = isRecord(value.data) && isRecord(value.data.update) ? value.data.update : null;
  if (update === null) return { type: 'ignored' };
  switch (update.sessionUpdate) {
    case 'tool_call':
      return { type: 'tool_call', id: str(update.toolCallId, 200), title: str(update.title, 200), rawInput: update.rawInput };
    case 'tool_call_update':
      // `content` and `rawOutput` hold the tool result: not read. The title and the input are read only to check them against the call.
      return {
        type: 'tool_call_update',
        id: str(update.toolCallId, 200),
        status: str(update.status, 40) || 'unknown',
        title: typeof update.title === 'string' && update.title !== '' ? str(update.title, 200) : null,
        rawInput: update.rawInput,
      };
    case 'session_info_update': {
      const kiro = isRecord(update._meta) && isRecord(update._meta.kiro) ? update._meta.kiro : null;
      if (kiro === null) return { type: 'ignored' };
      const usage = creditsOf(kiro);
      if (usage !== null) return { type: 'credits', usage };
      const turnEnd = isRecord(kiro.turnEnd) ? kiro.turnEnd : null;
      const elapsed = typeof kiro.elapsedTime === 'number' && Number.isFinite(kiro.elapsedTime) ? kiro.elapsedTime : null;
      const stop = str(kiro.stopReason, 60) || str(turnEnd?.stopReason, 60);
      if (elapsed !== null || stop !== '') return { type: 'turn', elapsedMs: elapsed, stopReason: stop === '' ? null : stop };
      return { type: 'ignored' };
    }
    default:
      return { type: 'ignored' };
  }
}

/**
 * Splits a byte stream into lines and classifies each. Keeps at most one partial line (up to
 * `MAX_LINE_BYTES`); a longer line yields one `malformed` and is skipped to its newline.
 */
export class StreamParser {
  private partial = '';
  private skipping = false;
  /** Count of `malformed` events so far, for the stream-error rule. */
  malformed = 0;

  push(chunk: string): HuntStreamEvent[] {
    const out: HuntStreamEvent[] = [];
    let rest = chunk;
    while (rest.length > 0) {
      const nl = rest.indexOf('\n');
      const piece = nl === -1 ? rest : rest.slice(0, nl);
      rest = nl === -1 ? '' : rest.slice(nl + 1);
      if (!this.skipping) {
        this.partial += piece;
        if (this.partial.length > MAX_LINE_BYTES) {
          this.skipping = true;
          this.partial = '';
          out.push(this.count({ type: 'malformed' }));
        }
      }
      if (nl !== -1) {
        if (this.skipping) this.skipping = false;
        else if (this.partial.trim() !== '') out.push(this.parse(this.partial));
        this.partial = '';
      }
    }
    return out;
  }

  /** At the end of the stream: a last line without a newline is still a line. */
  end(): HuntStreamEvent[] {
    const out: HuntStreamEvent[] = [];
    if (!this.skipping && this.partial.trim() !== '') out.push(this.parse(this.partial));
    this.partial = '';
    this.skipping = false;
    return out;
  }

  private parse(line: string): HuntStreamEvent {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return this.count({ type: 'malformed' });
    }
    return this.count(classify(value));
  }

  private count(ev: HuntStreamEvent): HuntStreamEvent {
    if (ev.type === 'malformed') this.malformed += 1;
    return ev;
  }
}
