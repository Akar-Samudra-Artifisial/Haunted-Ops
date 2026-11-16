import { HUNT_LIMITS, HUNT_TOOLS, type HuntTool } from '@haunted-ops/shared';
import { withoutPurpose } from '@haunted-ops/exorcist-mcp/schemas';
import type { HuntStreamEvent } from './stream-parser.js';

/** What stops a Hunt while it runs. */
export type GuardStop = 'foreign_tool' | 'credit_cap' | 'daily_cap' | 'tool_limit';

const TOOL_SET: ReadonlySet<string> = new Set(HUNT_TOOLS);
/**
 * The title of a call of one of our tools: `@exorcist/<tool>` (kiro-cli 3.2.1, IdC login) or `Running: @exorcist/<tool>`
 * (kiro-cli 3.3.0, API key login). One space, case sensitive, nothing before or after. Every other prefix is foreign.
 */
const MCP_TITLE = /^(?:Running: )?@exorcist\/([a-z_]{1,40})$/;
/** The only MCP server name a call of ours may carry. */
export const MCP_SERVER = 'exorcist';
/**
 * `kiro-cli` 3.3.0 loads a tool by id (`tool::exorcist::<tool>`); 3.2.1 (G0) listed bare names. The
 * `@exorcist/<tool>` form is the name a loaded tool is called by. Every form names only the six tools.
 */
const LOAD_ID = /^(?:tool::exorcist::|@exorcist\/)?([a-z_]{1,40})$/;
/** Keys that hold one id as a string, and keys that hold a list of ids. Anything else is not read. */
const ONE_ID_KEYS = ['id', 'tool_id'] as const;
const MANY_ID_KEYS = ['tool_ids', 'ids', 'tools', 'toolIds'] as const;

export type ToolCallVerdict =
  /** A call of one of the six tools. */
  | { kind: 'step'; tool: HuntTool; id: string; input: unknown }
  /** The built-in `Tool Load` that loads only the six tools. */
  | { kind: 'load'; id: string }
  /** Anything else: the Hunt must stop. */
  | { kind: 'foreign'; title: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export { withoutPurpose };
/** `_meta.kiro` identity fields of a tool event, as the parser extracts them. */
export interface CallMeta {
  toolName?: string | undefined;
  mcpServerName?: string | undefined;
}
/**
 * The tool a title of ours names, or null. The title must be exactly `@exorcist/<tool>` or `Running: @exorcist/<tool>`
 * with one of the six tools. When `mcpServerName` is present it must be `exorcist`, and when `toolName` is present it
 * must be the tool of the title: any disagreement is not our call.
 */
export function mcpToolOf(title: string, meta: CallMeta = {}): HuntTool | null {
  const m = MCP_TITLE.exec(title);
  if (m === null || !TOOL_SET.has(m[1] as string)) return null;
  if (meta.mcpServerName !== undefined && meta.mcpServerName !== MCP_SERVER) return null;
  if (meta.toolName !== undefined && meta.toolName !== m[1]) return null;
  return m[1] as HuntTool;
}
/** The tool names a `Tool Load` asks for, or null when they cannot be read. */
export function loadedTools(rawInput: unknown): string[] | null {
  if (!isRecord(rawInput)) return null;
  const ids: unknown[] = [];
  for (const key of ONE_ID_KEYS) if (rawInput[key] !== undefined) ids.push(rawInput[key]);
  for (const key of MANY_ID_KEYS) {
    if (rawInput[key] === undefined) continue;
    if (!Array.isArray(rawInput[key])) return null;
    ids.push(...(rawInput[key] as unknown[]));
  }
  if (ids.length === 0) return null;
  const names: string[] = [];
  for (const id of ids) {
    const m = typeof id === 'string' ? LOAD_ID.exec(id) : null;
    if (m === null) return null;
    names.push(m[1] as string);
  }
  return names;
}

/**
 * The allow-list: only the six `@exorcist/<tool>` calls, and a `Tool Load` that loads only those.
 * A `Tool Load` whose ids cannot be read is refused: we do not guess what it would load.
 */
export function checkToolCall(ev: Pick<Extract<HuntStreamEvent, { type: 'tool_call' }>, 'id' | 'title' | 'rawInput'> & CallMeta): ToolCallVerdict {
  const rawInput = withoutPurpose(ev.rawInput);
  const tool = mcpToolOf(ev.title, ev);
  if (tool !== null) return { kind: 'step', tool, id: ev.id, input: rawInput };
  if (ev.title === 'Tool Load') {
    const names = loadedTools(rawInput);
    if (names !== null && names.every((n) => TOOL_SET.has(n))) return { kind: 'load', id: ev.id };
  }
  if (ev.title === WRAPPER_TITLE) {
    const wrapped = wrappedCall(rawInput);
    if (wrapped !== null) return { kind: 'step', tool: wrapped.tool, id: ev.id, input: wrapped.arguments };
  }
  return { kind: 'foreign', title: ev.title };
}

/** kiro-cli 3.3.0 sometimes calls an MCP tool through this generic wrapper instead of `@exorcist/<tool>`. */
export const WRAPPER_TITLE = 'Tool Call';
const WRAPPER_TOOL_ID = /^tool::exorcist::([a-z_]{1,40})$/;

/**
 * The wrapper form: `rawInput` is exactly `{ tool_id: 'tool::exorcist::<tool>', arguments: { ... } }` with
 * one of the six tools. Any other key, another `tool_id` (another server, a built-in, a malformed one) or
 * arguments that are not an object is not accepted.
 */
export function wrappedCall(rawInput: unknown): { tool: HuntTool; arguments: Record<string, unknown> } | null {
  if (!isRecord(rawInput)) return null;
  const keys = Object.keys(withoutPurpose(rawInput) as Record<string, unknown>);
  if (keys.length !== 2 || !keys.includes('tool_id') || !keys.includes('arguments')) return null;
  const id = rawInput.tool_id;
  const m = typeof id === 'string' ? WRAPPER_TOOL_ID.exec(id) : null;
  if (m === null || !TOOL_SET.has(m[1] as string) || !isRecord(rawInput.arguments)) return null;
  return { tool: m[1] as HuntTool, arguments: withoutPurpose(rawInput.arguments) as Record<string, unknown> };
}

/** What an accepted `tool_call` was: one of the six tools, or a `Tool Load` of some of them. */
export type AcceptedCall = { kind: 'step'; tool: HuntTool } | { kind: 'load'; names: string[] };

/** The accepted call of a verdict, or null for a refused one. */
export function acceptedOf(verdict: ToolCallVerdict, rawInput: unknown): AcceptedCall | null {
  if (verdict.kind === 'step') return { kind: 'step', tool: verdict.tool };
  if (verdict.kind === 'load') return { kind: 'load', names: loadedTools(rawInput) ?? [] };
  return null;
}

const sameNames = (a: readonly string[], b: readonly string[]): boolean => {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((n, i) => n === y[i]);
};

/**
 * Whether a later event with the id of an accepted call (a repeated `tool_call` or a `tool_call_update`)
 * is that same call. It is when its title is missing, `null` or empty, or names the same accepted tool
 * (`@exorcist/<tool>`, `Tool Load` for the same load, or `Tool Call` for the same wrapped tool), and its
 * input, when it has one, names no other tool (`tool_id` of a wrapper, the ids of a load). Anything else is
 * not the same call: an id is not a way to give a second, different call the verdict of the first.
 */
export function isSameCall(accepted: AcceptedCall, title: string | null | undefined, input: unknown, meta: CallMeta = {}): boolean {
  const rawInput = withoutPurpose(input);
  const present = rawInput !== undefined && rawInput !== null;
  if (accepted.kind === 'step') {
    if (meta.mcpServerName !== undefined && meta.mcpServerName !== MCP_SERVER) return false;
    if (title === 'Tool Call') {
      if (present && wrappedCall(rawInput)?.tool !== accepted.tool) return false;
    } else if (title !== null && title !== undefined && title !== '' && mcpToolOf(title, meta) !== accepted.tool) {
      return false;
    }
    if (present && !isRecord(rawInput)) return false;
    if (present && isRecord(rawInput) && 'tool_id' in rawInput && rawInput.tool_id !== `tool::exorcist::${accepted.tool}`) return false;
    return true;
  }
  if (title !== null && title !== undefined && title !== '' && title !== 'Tool Load') return false;
  if (present && isRecord(rawInput) && [...ONE_ID_KEYS, ...MANY_ID_KEYS].some((k) => k in rawInput)) {
    const names = loadedTools(rawInput);
    if (names === null || !sameNames(names, accepted.names)) return false;
  } else if (present && !isRecord(rawInput)) {
    return false;
  }
  return true;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const shorten = (text: string, max: number): string => text.replace(CONTROL, ' ').trim().slice(0, max);

/**
 * A few words about a refused call, for the log and the `stopDetail` column: the title (control
 * characters stripped, 80 characters at most) and, for a `Tool Load`, the ids it asked for (at most
 * five, 60 characters each), and for a `Tool Call` wrapper its `tool_id`. Nothing else of the call is kept.
 */
export function describeForeign(title: string, rawInput: unknown): string {
  const head = shorten(title, 80) || '(no title)';
  if (title === WRAPPER_TITLE && isRecord(rawInput) && typeof rawInput.tool_id === 'string') {
    // The wrapper hides the tool behind `tool_id`: that is what was refused.
    return `${head} tool_id=${shorten(rawInput.tool_id, 60)}`.slice(0, 80);
  }
  if (title !== 'Tool Load' || !isRecord(rawInput)) return head;
  const ids: string[] = [];
  for (const key of [...ONE_ID_KEYS, ...MANY_ID_KEYS]) {
    const v = rawInput[key];
    for (const item of Array.isArray(v) ? v : [v]) if (typeof item === 'string') ids.push(shorten(item, 60));
  }
  return (ids.length === 0 ? head : `${head} ids=[${ids.slice(0, 5).join(',')}]`).slice(0, HUNT_LIMITS.stopDetail);
}

/** Counts the tool calls (steps and loads) of a Hunt. */
export class ToolCounter {
  private n = 0;

  constructor(private readonly max: number) {}

  get count(): number {
    return this.n;
  }

  /** Counts one call; `tool_limit` when the Hunt now has more calls than allowed. */
  add(): GuardStop | null {
    this.n += 1;
    return this.n > this.max ? 'tool_limit' : null;
  }
}

/**
 * The Credit totals of one Hunt and of its UTC day. A report is applied before it is checked, so the
 * recorded total is the real cost. The meter can only act when a report arrives (kiro-cli sends one
 * per turn), so a Hunt may exceed a cap by at most the Credits of one report.
 */
export class CreditMeter {
  private hunt = 0;
  private count = 0;

  constructor(
    private readonly creditCap: number,
    private readonly dailyCap: number,
    private readonly spentToday: number,
  ) {}

  get total(): number {
    return this.hunt;
  }

  /** How many Credits reports arrived. Kiro sends one at the end of a turn, so a Hunt stopped early has none. */
  get reports(): number {
    return this.count;
  }

  /** Credits of the day including this Hunt. */
  get dayTotal(): number {
    return this.spentToday + this.hunt;
  }

  add(usage: number): GuardStop | null {
    this.count += 1;
    if (Number.isFinite(usage) && usage > 0) this.hunt += usage;
    if (this.hunt >= this.creditCap) return 'credit_cap';
    if (this.dayTotal >= this.dailyCap) return 'daily_cap';
    return null;
  }
}

/** True when a Hunt may start: the day's spent Credits plus the per-hunt cap stay within the daily cap. */
export function fitsDailyBudget(spentToday: number, creditCap: number, dailyCap: number): boolean {
  return spentToday + creditCap <= dailyCap;
}

/** Index of the first event that makes the allow-list stop the Hunt, or -1. Used by tests and replays. */
export function firstForeignCall(events: readonly HuntStreamEvent[]): number {
  return events.findIndex((e) => e.type === 'tool_call' && checkToolCall(e).kind === 'foreign');
}
