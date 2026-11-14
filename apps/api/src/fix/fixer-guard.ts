import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { HuntStreamEvent } from '../hunts/stream-parser.js';
import { FIXER_TOOLS, type FixerTool } from './fix-env.js';

/**
 * The allow-list of the fixer stream, with the lessons of the Hunt allow-list: a call is judged once by what it
 * names, and every later event with the same call id (a repeated `tool_call` or a `tool_call_update`) passes only
 * when it names the same tool. The title shapes below are the ones of `kiro-cli` 3.3.0 as far as they are known
 * (a direct title, the `Tool Call` wrapper with a `tool_id`, a `Tool Load`, and updates with `title: null`); the
 * exact shapes of the file tools are pinned from the recording of task 10.1.
 */

/** Titles that name a file tool directly. */
// A Map, not an object literal: a title such as `toString` or `__proto__` must not find an inherited property.
const DIRECT_TITLES: ReadonlyMap<string, FixerTool> = new Map<string, FixerTool>([
  ['fs_read', 'fs_read'],
  ['fs_write', 'fs_write'],
  ['Read', 'fs_read'],
  ['Write', 'fs_write'],
]);
/** `tool::builtin::fs_read` and the bare name, as the wrapper and a load write them. */
const TOOL_ID = /^(?:tool::builtin::)?(fs_read|fs_write)$/;
export const WRAPPER_TITLE = 'Tool Call';
export const LOAD_TITLE = 'Tool Load';
/** Keys that hold a path (or a list of paths) in the input of a file tool: these names, and any key ending in `path` or `paths`. */
const PATH_KEYS = new Set(['file', 'files', 'target', 'source', 'destination', 'dest', 'directory', 'dir', 'cwd', 'root']);
export const isPathKey = (key: string): boolean => PATH_KEYS.has(key) || /paths?$/i.test(key);

export type FixerVerdict = { kind: 'step'; tool: FixerTool } | { kind: 'load'; tools: FixerTool[] } | { kind: 'foreign'; title: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every string under a path key, at any depth, of the input of a call. A path key holding anything else is kept as a non-path. */
export function pathsOf(input: unknown, depth = 0): string[] {
  if (depth > 6) return [];
  if (Array.isArray(input)) return input.flatMap((v) => pathsOf(v, depth + 1));
  if (!isRecord(input)) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (isPathKey(key)) {
      if (typeof value === 'string') out.push(value);
      else if (Array.isArray(value)) for (const v of value) out.push(...(typeof v === 'string' ? [v] : pathsOf(v, depth + 1)));
      else out.push(...pathsOf(value, depth + 1));
    } else if (isRecord(value) || Array.isArray(value)) {
      out.push(...pathsOf(value, depth + 1));
    }
  }
  return out;
}

/**
 * The argument shapes the two file tools may have, as `kiro-cli` 3.3.0 sends them. Anything else is not understood,
 * and a call that is not understood stops the run (fail closed): a key the guard does not know could carry a path.
 *  - `fs_read`: `{ operations: [op, ...], summary? }`, or one op on its own; an op is `{ mode, path, ... }` for the
 *    modes `Line`, `Directory` and `Search`, and `{ mode: 'Image', image_paths: [...] }`.
 *  - `fs_write`: `{ command, path, file_text?, old_str?, new_str?, insert_line?, summary? }` with `command` one of
 *    `create`, `str_replace`, `append`, `insert`.
 * Every path, at any depth, must also be inside the folder (checked by the caller).
 */
const READ_OP_KEYS = new Set(['mode', 'path', 'image_paths', 'start_line', 'end_line', 'depth', 'pattern', 'context_lines']);
const READ_MODES = new Set(['Line', 'Directory', 'Search', 'Image']);
const WRITE_KEYS = new Set(['command', 'path', 'file_text', 'old_str', 'new_str', 'insert_line', 'summary']);
const WRITE_COMMANDS = new Set(['create', 'str_replace', 'append', 'insert']);
const MAX_OPERATIONS = 20;

const isInt = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= MAX_OPERATIONS && v.every((x) => typeof x === 'string');

function readOpProblem(op: unknown): string | null {
  if (!isRecord(op)) return 'operation is not an object';
  for (const key of Object.keys(op)) if (!READ_OP_KEYS.has(key)) return `unknown key ${key.slice(0, 30)}`;
  if (op.mode !== undefined && (typeof op.mode !== 'string' || !READ_MODES.has(op.mode))) return 'unknown mode';
  if (op.mode === 'Image') {
    if (!isStringList(op.image_paths)) return 'image_paths is not a list of paths';
    if (op.path !== undefined && typeof op.path !== 'string') return 'path is not a string';
  } else if (typeof op.path !== 'string') return 'path is missing';
  if (op.image_paths !== undefined && op.mode !== 'Image') return 'image_paths outside the Image mode';
  for (const key of ['start_line', 'end_line', 'depth', 'context_lines']) if (op[key] !== undefined && !isInt(op[key])) return `${key} is not a number`;
  if (op.pattern !== undefined && typeof op.pattern !== 'string') return 'pattern is not a string';
  return null;
}

/** Why the arguments of a file tool are not understood, or null when they are. */
export function fileToolArgsProblem(tool: FixerTool, args: unknown): string | null {
  if (!isRecord(args)) return 'arguments are not an object';
  if (tool === 'fs_write') {
    for (const key of Object.keys(args)) if (!WRITE_KEYS.has(key)) return `unknown key ${key.slice(0, 30)}`;
    if (typeof args.command !== 'string' || !WRITE_COMMANDS.has(args.command)) return 'unknown command';
    if (typeof args.path !== 'string') return 'path is missing';
    for (const key of ['file_text', 'old_str', 'new_str', 'summary']) if (args[key] !== undefined && typeof args[key] !== 'string') return `${key} is not a string`;
    if (args.insert_line !== undefined && !isInt(args.insert_line)) return 'insert_line is not a number';
    return null;
  }
  if ('operations' in args) {
    for (const key of Object.keys(args)) if (key !== 'operations' && key !== 'summary') return `unknown key ${key.slice(0, 30)}`;
    if (args.summary !== undefined && typeof args.summary !== 'string') return 'summary is not a string';
    const ops = args.operations;
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OPERATIONS) return 'operations is not a list';
    for (const op of ops) {
      const problem = readOpProblem(op);
      if (problem !== null) return problem;
    }
    return null;
  }
  // One operation on its own (an older form); a summary may come with it.
  const { summary, ...op } = args;
  if (summary !== undefined && typeof summary !== 'string') return 'summary is not a string';
  return readOpProblem(op);
}

/**
 * True when `p` names a place inside `folder`. Absolute paths must start with the folder, relative ones are
 * resolved against it, and `..`, `~`, `$`, a scheme, a NUL, a backslash and percent escapes are refused outright:
 * a path that needs any of them is not a path the fixer has a reason to use.
 */
export function isInside(folder: string, p: string): boolean {
  if (p === '' || p.length > 400 || p.includes('\0') || p.includes('\\') || p.includes('%') || p.includes('~') || p.includes('$') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(p)) return false;
  if (p.split('/').includes('..')) return false;
  const root = resolve(folder);
  const full = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(root, full);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

/** The tools named by the ids of a `Tool Load`, or null when one id is not a file tool or none can be read. */
function loadedFixerTools(rawInput: unknown): FixerTool[] | null {
  if (!isRecord(rawInput)) return null;
  const ids: unknown[] = [];
  for (const key of ['id', 'tool_id']) if (key in rawInput) ids.push(rawInput[key]);
  for (const key of ['tool_ids', 'ids', 'tools', 'toolIds']) {
    if (key in rawInput) {
      if (!Array.isArray(rawInput[key])) return null;
      ids.push(...(rawInput[key] as unknown[]));
    }
  }
  if (ids.length === 0) return null;
  const tools: FixerTool[] = [];
  for (const id of ids) {
    const m = typeof id === 'string' ? TOOL_ID.exec(id) : null;
    if (m === null) return null;
    tools.push(m[1] as FixerTool);
  }
  return tools;
}

/** The tool a `Tool Call` wrapper names: exactly `tool_id` and `arguments`, an object, a file tool. */
function wrappedFixerCall(rawInput: unknown): { tool: FixerTool; arguments: Record<string, unknown> } | null {
  if (!isRecord(rawInput)) return null;
  const keys = Object.keys(rawInput).sort().join(',');
  if (keys !== 'arguments,tool_id' || !isRecord(rawInput.arguments) || typeof rawInput.tool_id !== 'string') return null;
  const m = TOOL_ID.exec(rawInput.tool_id);
  return m === null ? null : { tool: m[1] as FixerTool, arguments: rawInput.arguments };
}

/** What the allow-list says about one `tool_call`. */
export function checkFixerCall(title: string, rawInput: unknown): FixerVerdict {
  const direct = DIRECT_TITLES.get(title);
  if (direct !== undefined) return { kind: 'step', tool: direct };
  if (title === WRAPPER_TITLE) {
    const wrapped = wrappedFixerCall(rawInput);
    return wrapped === null ? { kind: 'foreign', title } : { kind: 'step', tool: wrapped.tool };
  }
  if (title === LOAD_TITLE) {
    const tools = loadedFixerTools(rawInput);
    return tools === null ? { kind: 'foreign', title } : { kind: 'load', tools };
  }
  return { kind: 'foreign', title };
}

type Accepted = { kind: 'step'; tool: FixerTool } | { kind: 'load'; tools: FixerTool[] };

/**
 * Whether a later event with the id of an accepted call is that same call: its title is missing or names the same
 * tool (the wrapper for the same wrapped tool, a load for the same tools), and its input, when it has one, names no
 * other tool.
 */
export function isSameFixerCall(accepted: Accepted, title: string | null | undefined, rawInput: unknown): boolean {
  const none = title === null || title === undefined || title === '';
  if (accepted.kind === 'load') {
    if (!none && title !== LOAD_TITLE) return false;
    if (rawInput === undefined || rawInput === null) return true;
    const tools = loadedFixerTools(rawInput);
    return tools !== null && [...new Set(tools)].sort().join() === [...new Set(accepted.tools)].sort().join();
  }
  if (!none) {
    if (title === WRAPPER_TITLE) {
      if (rawInput !== undefined && rawInput !== null && wrappedFixerCall(rawInput)?.tool !== accepted.tool) return false;
    } else if (DIRECT_TITLES.get(title as string) !== accepted.tool) {
      return false;
    }
  }
  if (rawInput !== undefined && rawInput !== null) {
    if (!isRecord(rawInput)) return false;
    if ('tool_id' in rawInput) {
      const m = typeof rawInput.tool_id === 'string' ? TOOL_ID.exec(rawInput.tool_id) : null;
      if (m === null || m[1] !== accepted.tool) return false;
    }
  }
  return true;
}

/** A short, cleaned description of a refused call, for the log and the stop detail. */
export function describeFixerStop(title: string, rawInput: unknown): string {
  // eslint-disable-next-line no-control-regex
  const clean = (s: string, n: number): string => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, n);
  const head = clean(title, 80) || '(no title)';
  if (title === WRAPPER_TITLE && isRecord(rawInput) && typeof rawInput.tool_id === 'string') return `${WRAPPER_TITLE} tool_id=${clean(rawInput.tool_id, 60)}`.slice(0, 80);
  return head;
}

export type GuardOutcome = { kind: 'pass' } | { kind: 'step' } | { kind: 'stop'; detail: string };

/** The state of one run: the tool accepted for each call id, and the count of calls. */
export class FixerGuard {
  private readonly accepted = new Map<string, Accepted>();
  private calls = 0;

  constructor(private readonly folder: string) {}

  /** How many tool calls (steps and loads) were accepted. */
  get count(): number {
    return this.calls;
  }

  /**
   * The arguments of an accepted file tool, wherever they come in (a direct input or the `arguments` of the wrapper):
   * a known shape (`fileToolArgsProblem`) and every path inside the folder. A missing or empty input carries nothing
   * yet (the real stream may send the arguments in a later update) and is judged when they arrive.
   */
  private argsOutcome(tool: FixerTool, rawInput: unknown): GuardOutcome | null {
    if (rawInput === undefined || rawInput === null || (isRecord(rawInput) && Object.keys(rawInput).length === 0)) return null;
    const args = 'tool_id' in (isRecord(rawInput) ? rawInput : {}) ? wrappedFixerCall(rawInput)?.arguments : rawInput;
    if (args === undefined) return { kind: 'stop', detail: `${tool} arguments not understood` };
    const problem = fileToolArgsProblem(tool, args);
    if (problem !== null) return { kind: 'stop', detail: `${tool} arguments not understood: ${problem}`.slice(0, 120) };
    if (!pathsOf(args).every((p) => isInside(this.folder, p))) return { kind: 'stop', detail: `${tool} path outside the folder` };
    return null;
  }

  /** A call seen for the first time: a file tool (or a load of them) with understood arguments is accepted and counted. */
  private accept(id: string, title: string, rawInput: unknown): GuardOutcome {
    const verdict = checkFixerCall(title, rawInput);
    if (verdict.kind === 'foreign') return { kind: 'stop', detail: describeFixerStop(title, rawInput) };
    if (verdict.kind === 'step') {
      const bad = this.argsOutcome(verdict.tool, rawInput);
      if (bad !== null) return bad;
    }
    this.accepted.set(id, verdict.kind === 'step' ? { kind: 'step', tool: verdict.tool } : { kind: 'load', tools: verdict.tools });
    this.calls += 1;
    return { kind: 'step' };
  }

  /** A later event of an accepted call: the same tool, and arguments (when it carries some) that are understood. */
  private again(known: Accepted, title: string | null | undefined, rawInput: unknown): GuardOutcome {
    if (!isSameFixerCall(known, title, rawInput)) return { kind: 'stop', detail: describeFixerStop(title ?? '', rawInput) };
    if (known.kind === 'load') return { kind: 'pass' };
    return this.argsOutcome(known.tool, rawInput) ?? { kind: 'pass' };
  }

  /** Judges one stream event. `step`: a new call to count; `pass`: nothing to do; `stop`: stop the process group. */
  judge(ev: HuntStreamEvent): GuardOutcome {
    if (ev.type === 'tool_call') {
      const known = this.accepted.get(ev.id);
      return known !== undefined ? this.again(known, ev.title, ev.rawInput) : this.accept(ev.id, ev.title, ev.rawInput);
    }
    if (ev.type === 'tool_call_update') {
      const known = this.accepted.get(ev.id);
      if (known !== undefined) return this.again(known, ev.title, ev.rawInput);
      // An update of a call that was never announced. With no title it names nothing the guard could judge, so it is
      // refused; with a title it is judged like a new call, and counted.
      if (ev.title === null || ev.title === undefined || ev.title === '') return { kind: 'stop', detail: 'update of an unknown call' };
      return this.accept(ev.id, ev.title, ev.rawInput);
    }
    return { kind: 'pass' };
  }
}

export const fixerToolNames: readonly string[] = FIXER_TOOLS;
