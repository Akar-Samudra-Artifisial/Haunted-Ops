import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { HuntStreamEvent } from '../hunts/stream-parser.js';
import { FIXER_TOOLS, type FixerTool } from './fix-env.js';
import { MAX_PATCH_FILE_BYTES } from './patch-checks.js';

/**
 * The allow-list of the fixer stream, with the lessons of the Hunt allow-list: a call is judged once by what it
 * names, and every later event with the same call id (a repeated `tool_call` or a `tool_call_update`) passes only
 * when it names the same tool.
 *
 * The shapes of the file tools are pinned from three recordings of `kiro-cli` 3.3.0 with the `exorcist-fixer` agent,
 * kept sanitized in `apps/api/test/fixtures/fixer-streams/`: `live-fix-first-call.stream.jsonl` (the first call of a
 * real fix run), `probe-replace.stream.jsonl` (read, then edit) and `probe-create.stream.jsonl` (a new file):
 *  - `Read File` (kind `read`): `{ path, offset: null, limit: null }`;
 *  - `Replace in File` (kind `edit`): `{ path, oldStr, newStr }`, its updates add `replace_all`;
 *  - `Write File` (kind `edit`): `{ path, text }`;
 *  - updates: `title` absent or null first, then the same title, with the same keys.
 * A fourth recording (the live test 10.2, task 19) showed a second read shape: the title `Reading <file>:<line>` (kind
 * `read`), `rawInput` `{ operations: [{ mode, path }] }`, and the stable tool name in `_meta.kiro.toolName` (`read`,
 * `write`). When `toolName` is present it names the tool first and any other name is refused; the title is a second
 * source and a title that names the other tool is refused.
 * A fifth recording (the live test 10.2, task 20) showed the write in the same style: the title `Editing <file>` (kind
 * `edit`), `rawInput` `{ command: "strReplace", path, oldStr, newStr, replace_all? }` and `toolName` `write`.
 * Task 22 moved the identity from the title to the stable name and the arguments to the tool schema inside the binary
 * (not a recording): with `toolName` present it alone names the tool (`read`, `write`; anything else is refused) and the
 * title is decorative (one clean line); an update of an accepted id keeps its tool whatever its title or `_meta` say
 * and has its arguments judged again; `write` takes `create`, `strReplace` and `insert` with the schema keys (and the
 * snake_case family); `read` takes `Line` and `Directory` operations (`Image` is refused as `image_read`).
 * `path` is relative to the work folder. The older forms (`fs_read`/`fs_write`, the `Tool Call` wrapper with a
 * `tool_id`, `Tool Load`) stay accepted. Every other title is foreign and stops the run (fail closed).
 */

/** Titles that name a file tool directly. */
// A Map, not an object literal: a title such as `toString` or `__proto__` must not find an inherited property.
const DIRECT_TITLES: ReadonlyMap<string, FixerTool> = new Map<string, FixerTool>([
  ['fs_read', 'fs_read'],
  ['fs_write', 'fs_write'],
  ['Read', 'fs_read'],
  ['Write', 'fs_write'],
  // Recorded from kiro-cli 3.3.0 (see above).
  ['Read File', 'fs_read'],
  ['Replace in File', 'fs_write'],
  ['Write File', 'fs_write'],
]);
/** `Reading <file>:<line>` (kiro-cli 3.3.0, kind `read`): the title is dynamic, so it is a pattern. One line, no control character. */
// eslint-disable-next-line no-control-regex
const READING_TITLE = /^Reading [^\u0000-\u001f\u007f-\u009f]+$/;
/** `Editing <file>` (kiro-cli 3.3.0, kind `edit`): the title is dynamic, so it is a pattern. One line, no control character. */
// eslint-disable-next-line no-control-regex
const EDITING_TITLE = /^Editing [^\u0000-\u001f\u007f-\u009f]+$/;
/** Any title of a call that has its stable tool name: one line of at most 200 characters, no control character. */
// eslint-disable-next-line no-control-regex
const PLAIN_TITLE = /^[^\u0000-\u001f\u007f-\u009f]{1,200}$/;
/** `_meta.kiro.toolName` to the file tool it names. Any other name is refused. */
const TOOL_NAMES: ReadonlyMap<string, FixerTool> = new Map<string, FixerTool>([
  ['read', 'fs_read'],
  ['write', 'fs_write'],
]);
/** The file tool a title names, or null. `kind` is the kind of a `tool_call` (the dynamic `Reading ...` title needs `read`). */
function titleTool(title: string, kind?: string): FixerTool | null {
  const direct = DIRECT_TITLES.get(title);
  if (direct !== undefined) return direct;
  if (kind === 'read' && READING_TITLE.test(title)) return 'fs_read';
  return kind === 'edit' && EDITING_TITLE.test(title) ? 'fs_write' : null;
}
const cleanName = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, 30);
/** The titles a recorded fixer run uses, for tests. */
export const RECORDED_TITLES = ['Read File', 'Replace in File', 'Write File'] as const;
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
 *  - `fs_read`: `{ path, offset?, limit? }` (Read File), or `{ operations: [op, ...], summary? }` with 1 to 8 ops; an
 *    op is `{ mode, path, ... }` for the modes `Line`, `Directory` and `Search`. `Image` mode and `image_paths` are refused.
 *  - `fs_write`: `{ command, path, file_text?, old_str?, new_str?, insert_line?, summary? }` with `command` one of
 *    `create`, `str_replace`, `append`, `insert`.
 * Every path, at any depth, must also be inside the folder (checked by the caller).
 */
/** The keys of a read operation, per mode (the schema of kiro-cli 3.3.0; `Search` and its keys are the older shape). */
const READ_OP_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['Line', new Set(['mode', 'path', 'offset', 'limit', 'start_line', 'end_line'])],
  ['Directory', new Set(['mode', 'path', 'depth', 'exclude_patterns'])],
  ['Search', new Set(['mode', 'path', 'pattern', 'context_lines', 'depth'])],
]);
/** `Image` (and its `image_paths`) is refused with the reason `image_read`: the fixer reads source text only. */
export const IMAGE_READ = 'image_read';
const MAX_OPERATIONS = 8;
const MAX_DEPTH = 5;
const MAX_EXCLUDE_PATTERNS = 20;
const MAX_EXCLUDE_LENGTH = 100;

const isInt = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v);
const nullOrInt = (v: unknown): boolean => v === null || v === undefined || isInt(v);

function readOpProblem(op: unknown): string | null {
  if (!isRecord(op)) return 'operation is not an object';
  if (op.mode === 'Image') return IMAGE_READ;
  const allowed = typeof op.mode === 'string' ? READ_OP_KEYS.get(op.mode) : undefined;
  if (allowed === undefined) return 'unknown mode';
  for (const key of Object.keys(op)) if (!allowed.has(key)) return `unknown key ${cleanName(key)}`;
  if (typeof op.path !== 'string') return 'path is missing';
  for (const key of ['offset', 'limit']) if (!nullOrInt(op[key])) return `${key} is not a number`;
  for (const key of ['start_line', 'end_line', 'context_lines']) if (op[key] !== undefined && !isInt(op[key])) return `${key} is not a number`;
  if (op.depth !== undefined && (!isInt(op.depth) || (op.depth as number) < 0 || (op.depth as number) > MAX_DEPTH)) return 'depth is not a number from 0 to 5';
  if (op.pattern !== undefined && typeof op.pattern !== 'string') return 'pattern is not a string';
  const exclude = op.exclude_patterns;
  if (exclude !== undefined) {
    if (!Array.isArray(exclude) || exclude.length > MAX_EXCLUDE_PATTERNS) return 'exclude_patterns is not a short list';
    if (!exclude.every((p) => typeof p === 'string' && p.length <= MAX_EXCLUDE_LENGTH)) return 'exclude_patterns holds a value that is not short text';
  }
  return null;
}

/**
 * The write schema of kiro-cli 3.3.0 (`write`, read from the tool schema inside the binary, not recorded):
 *  - `create`: `{ command, path, content }`; `strReplace`: `{ command, path, oldStr, newStr, replaceAll? }`;
 *    `insert`: `{ command, path, content, insertLine? }` (`insertLine` a whole number from 0). `summary` is optional text.
 *  - `replace_all` (a boolean, also null) is the spelling the recordings show for `strReplace`; it stays accepted.
 *  - The older snake_case family (`create`, `str_replace`, `append`, `insert` with `file_text`, `old_str`, `new_str`,
 *    `insert_line`) stays accepted. A call with keys of both families is refused.
 */
const SCHEMA_WRITE_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['create', new Set(['command', 'path', 'content', 'summary'])],
  ['strReplace', new Set(['command', 'path', 'oldStr', 'newStr', 'replaceAll', 'replace_all', 'summary'])],
  ['insert', new Set(['command', 'path', 'content', 'insertLine', 'summary'])],
]);
const LEGACY_WRITE_KEYS = new Set(['command', 'path', 'file_text', 'old_str', 'new_str', 'insert_line', 'summary']);
const LEGACY_ONLY_KEYS = new Set(['file_text', 'old_str', 'new_str', 'insert_line']);
const LEGACY_WRITE_COMMANDS = new Set(['create', 'str_replace', 'append', 'insert']);
const longText = (v: unknown): boolean => typeof v === 'string' && v.length > MAX_PATCH_FILE_BYTES;

const READ_FILE_KEYS = new Set(['path', 'offset', 'limit']);
const REPLACE_KEYS = new Set(['path', 'oldStr', 'newStr', 'replace_all']);
const WRITE_FILE_KEYS = new Set(['path', 'text']);

/** `Read File`: `{ path, offset, limit }`; `offset` and `limit` may be null. */
function recordedReadProblem(args: Record<string, unknown>): string | null {
  for (const key of Object.keys(args)) if (!READ_FILE_KEYS.has(key)) return `unknown key ${cleanName(key)}`;
  if (typeof args.path !== 'string') return 'path is missing';
  if (!nullOrInt(args.offset) || !nullOrInt(args.limit)) return 'offset or limit is not a number';
  return null;
}

/** `Replace in File`: `{ path, oldStr, newStr, replace_all? }`; `Write File`: `{ path, text }`. */
function recordedWriteProblem(args: Record<string, unknown>): string | null {
  const keys = Object.keys(args);
  if (typeof args.path !== 'string') return 'path is missing';
  if ('text' in args) {
    for (const key of keys) if (!WRITE_FILE_KEYS.has(key)) return `unknown key ${cleanName(key)}`;
    return typeof args.text === 'string' ? null : 'text is not a string';
  }
  for (const key of keys) if (!REPLACE_KEYS.has(key)) return `unknown key ${cleanName(key)}`;
  if (typeof args.oldStr !== 'string' || typeof args.newStr !== 'string') return 'oldStr or newStr is not a string';
  if (args.replace_all !== undefined && args.replace_all !== null && typeof args.replace_all !== 'boolean') return 'replace_all is not a boolean';
  return null;
}

/** A write in the schema family of kiro-cli 3.3.0: `command` is `create`, `strReplace` or `insert`. */
function schemaWriteProblem(args: Record<string, unknown>, command: string): string | null {
  const allowed = SCHEMA_WRITE_KEYS.get(command) as ReadonlySet<string>;
  for (const key of Object.keys(args)) if (!allowed.has(key)) return `unknown key ${cleanName(key)}`;
  if (typeof args.path !== 'string') return 'path is missing';
  if (args.summary !== undefined && typeof args.summary !== 'string') return 'summary is not a string';
  if (command === 'strReplace') {
    if (typeof args.oldStr !== 'string' || typeof args.newStr !== 'string') return 'oldStr or newStr is not a string';
    if (longText(args.oldStr) || longText(args.newStr)) return 'oldStr or newStr is too long';
    if (args.replaceAll !== undefined && typeof args.replaceAll !== 'boolean') return 'replaceAll is not a boolean';
    if (args.replace_all !== undefined && args.replace_all !== null && typeof args.replace_all !== 'boolean') return 'replace_all is not a boolean';
    return null;
  }
  if (args.content === undefined) return 'content is missing';
  if (typeof args.content !== 'string') return 'content is not a string';
  if (longText(args.content)) return 'content is too long';
  if (command === 'insert' && args.insertLine !== undefined && (!isInt(args.insertLine) || (args.insertLine as number) < 0)) return 'insertLine is not a whole number from 0';
  return null;
}

/** A write in the older snake_case family: `create`, `str_replace`, `append` or `insert`. */
function legacyWriteProblem(args: Record<string, unknown>): string | null {
  for (const key of Object.keys(args)) if (!LEGACY_WRITE_KEYS.has(key)) return `unknown key ${cleanName(key)}`;
  if (typeof args.path !== 'string') return 'path is missing';
  for (const key of ['file_text', 'old_str', 'new_str', 'summary']) if (args[key] !== undefined && typeof args[key] !== 'string') return `${key} is not a string`;
  if (args.insert_line !== undefined && !isInt(args.insert_line)) return 'insert_line is not a number';
  return null;
}

/** A write with a `command`: the schema family, or (for `create`, `insert` with a snake_case key) the older one. */
function writeCommandProblem(args: Record<string, unknown>): string | null {
  const command = args.command;
  if (typeof command !== 'string') return 'unknown command';
  const unknown = `unknown command ${cleanName(command)}`;
  if (command === 'strReplace') return schemaWriteProblem(args, command);
  if (command === 'create' || command === 'insert') return Object.keys(args).some((k) => LEGACY_ONLY_KEYS.has(k)) ? legacyWriteProblem(args) : schemaWriteProblem(args, command);
  return LEGACY_WRITE_COMMANDS.has(command) ? legacyWriteProblem(args) : unknown;
}

/**
 * Why the arguments of a file tool are not understood, or null when they are. `strict` is a call that came with the
 * stable tool name or the `Editing <file>` title: its arguments must carry a `command`, as the schema says.
 */
export function fileToolArgsProblem(tool: FixerTool, args: unknown, strict = false): string | null {
  if (!isRecord(args)) return 'arguments are not an object';
  if (tool === 'fs_write') {
    if (!('command' in args)) return strict ? 'command is missing' : recordedWriteProblem(args);
    return writeCommandProblem(args);
  }
  if ('operations' in args) {
    for (const key of Object.keys(args)) if (key !== 'operations' && key !== 'summary') return `unknown key ${cleanName(key)}`;
    if (args.summary !== undefined && typeof args.summary !== 'string') return 'summary is not a string';
    const ops = args.operations;
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OPERATIONS) return 'operations is not a list';
    for (const op of ops) {
      const problem = readOpProblem(op);
      if (problem !== null) return problem;
    }
    return null;
  }
  // The recorded `Read File` form: `{ path, offset?, limit? }`, the two numbers null or whole.
  return recordedReadProblem(args);
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
export function checkFixerCall(title: string, rawInput: unknown, kind?: string, toolName?: string): FixerVerdict {
  // The stable name is the identity when present: `read` and `write` name the two file tools, anything else is refused.
  // The title is then decorative: it only has to be one clean line (the arguments are judged all the same).
  if (toolName !== undefined) {
    const named = TOOL_NAMES.get(toolName) ?? null;
    if (named === null) return { kind: 'foreign', title: `toolName=${cleanName(toolName)}` };
    if (title === WRAPPER_TITLE) {
      const wrapped = wrappedFixerCall(rawInput);
      return wrapped === null || wrapped.tool !== named ? { kind: 'foreign', title } : { kind: 'step', tool: named };
    }
    return title === '' || PLAIN_TITLE.test(title) ? { kind: 'step', tool: named } : { kind: 'foreign', title };
  }
  const direct = titleTool(title, kind);
  if (direct !== null) return { kind: 'step', tool: direct };
  if (title === WRAPPER_TITLE) {
    const wrapped = wrappedFixerCall(rawInput);
    if (wrapped === null) return { kind: 'foreign', title };
    return { kind: 'step', tool: wrapped.tool };
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
export function isSameFixerCall(accepted: Accepted, title: string | null | undefined, rawInput: unknown, toolName?: string): boolean {
  const none = title === null || title === undefined || title === '';
  if (toolName !== undefined && (accepted.kind === 'load' || TOOL_NAMES.get(toolName) !== accepted.tool)) return false;
  if (accepted.kind === 'load') {
    if (!none && title !== LOAD_TITLE) return false;
    if (rawInput === undefined || rawInput === null) return true;
    const tools = loadedFixerTools(rawInput);
    return tools !== null && [...new Set(tools)].sort().join() === [...new Set(accepted.tools)].sort().join();
  }
  if (!none && toolName !== undefined) {
    // The stable name is the identity (it names the accepted tool): the title is decorative, one clean line.
    if (!PLAIN_TITLE.test(title as string)) return false;
  } else if (!none) {
    if (title === WRAPPER_TITLE) {
      if (rawInput !== undefined && rawInput !== null && wrappedFixerCall(rawInput)?.tool !== accepted.tool) return false;
    } else if (
      DIRECT_TITLES.get(title as string) !== accepted.tool &&
      !(accepted.tool === 'fs_read' && READING_TITLE.test(title as string)) &&
      !(accepted.tool === 'fs_write' && EDITING_TITLE.test(title as string))
    ) {
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

/** Why the guard stopped a run, as a fixed code (logged as `fixerHalt.code` and stored with the Proposal). */
export type GuardStopCode = 'foreign_tool' | 'unknown_args' | 'path_outside' | 'write_outside_scope' | 'unknown_update' | 'unjudged_input';

/** An input the guard can judge: present and not an empty object. */
const hasInput = (rawInput: unknown): boolean => rawInput !== undefined && rawInput !== null && !(isRecord(rawInput) && Object.keys(rawInput).length === 0);
export type GuardOutcome = { kind: 'pass' } | { kind: 'step' } | { kind: 'stop'; code: GuardStopCode; detail: string };
/** The key names of an input (and of the `arguments` of the wrapper), cleaned and bounded, never a value. */
export function keySetOf(rawInput: unknown): string {
  const clean = (k: string): string => k.replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, 30);
  if (!isRecord(rawInput)) return rawInput === undefined || rawInput === null ? 'keys=none' : `keys=${typeof rawInput}`;
  const top = Object.keys(rawInput).slice(0, 12).map(clean).sort();
  const inner = isRecord(rawInput.arguments) ? ` args=[${Object.keys(rawInput.arguments).slice(0, 12).map(clean).sort().join(',')}]` : '';
  return `keys=[${top.join(',')}]${inner}`;
}
/** The event kind (`read`, `edit`, `other`, ...) for a stop detail, cleaned; `none` when the event has none. */
const kindOf = (kind: string | undefined): string => (kind === undefined || kind === '' ? 'none' : kind.replace(/[^A-Za-z0-9_-]/g, '?').slice(0, 20));
/** A stop with its detail: the words, then the event kind and the sorted key names of the input (never a value). */
const stop = (code: GuardStopCode, detail: string, rawInput: unknown, kind?: string): GuardOutcome => ({
  kind: 'stop',
  code,
  detail: `${detail} kind=${kindOf(kind)} ${keySetOf(rawInput)}`.slice(0, 280),
});

export interface FixerGuardOptions {
  /**
   * Where `fs_write` may write, relative to the folder: `services/<service>/src/`. A write elsewhere stops the run with
   * `write_outside_scope` (the patch checks would refuse it later; stopping early saves Credits and says why).
   */
  writeScope?: string;
}

/** True when `p` (relative or absolute, already known to be inside `folder`) is under `scope` of `folder`. */
function isUnder(folder: string, p: string, scope: string): boolean {
  const rel = relative(resolve(folder), isAbsolute(p) ? resolve(p) : resolve(folder, p)).split(sep).join('/');
  return rel.startsWith(scope) && rel.length > scope.length;
}

/** The state of one run: the tool accepted for each call id, and the count of calls. */
export class FixerGuard {
  private readonly accepted = new Map<string, Accepted>();
  /** Ids of file-tool calls whose arguments were judged (a non-empty input was seen and passed). */
  private readonly judged = new Set<string>();
  /** Ids of write calls announced with the stable tool name or an `Editing <file>` title: their arguments must carry a `command`. */
  private readonly strict = new Set<string>();
  private calls = 0;
  private writeCalls = 0;
  private readonly writeScope: string | null;
  /** The kind of the event being judged, for the stop detail. */
  private eventKind: string | undefined;

  constructor(
    private readonly folder: string,
    o: FixerGuardOptions = {},
  ) {
    const scope = o.writeScope;
    this.writeScope = scope === undefined ? null : scope.endsWith('/') ? scope : `${scope}/`;
  }

  /** How many accepted calls were `fs_write` (a run with none cannot have changed a file). */
  get writes(): number {
    return this.writeCalls;
  }

  /** How many tool calls (steps and loads) were accepted. */
  get count(): number {
    return this.calls;
  }

  /**
   * The arguments of an accepted file tool, wherever they come in (a direct input or the `arguments` of the wrapper):
   * a known shape (`fileToolArgsProblem`) and every path inside the folder. A missing or empty input carries nothing
   * yet (the real stream may send the arguments in a later update) and is judged when they arrive.
   */
  private argsOutcome(tool: FixerTool, rawInput: unknown, strict = false): GuardOutcome | null {
    if (rawInput === undefined || rawInput === null || (isRecord(rawInput) && Object.keys(rawInput).length === 0)) return null;
    const args = 'tool_id' in (isRecord(rawInput) ? rawInput : {}) ? wrappedFixerCall(rawInput)?.arguments : rawInput;
    const k = this.eventKind;
    if (args === undefined) return stop('unknown_args', `${tool} arguments not understood`, rawInput, k);
    const problem = fileToolArgsProblem(tool, args, strict);
    if (problem !== null) return stop('unknown_args', `${tool} arguments not understood: ${problem}`.slice(0, 120), rawInput, k);
    const paths = pathsOf(args);
    if (!paths.every((p) => isInside(this.folder, p))) return stop('path_outside', `${tool} path outside the folder`, rawInput, k);
    const scope = this.writeScope;
    if (tool === 'fs_write' && scope !== null && !paths.every((p) => isUnder(this.folder, p, scope))) {
      return stop('write_outside_scope', `fs_write outside ${scope}`, rawInput, k);
    }
    return null;
  }

  /** A call seen for the first time: a file tool (or a load of them) with understood arguments is accepted and counted. */
  private accept(id: string, title: string, rawInput: unknown, kind?: string, toolName?: string): GuardOutcome {
    const verdict = checkFixerCall(title, rawInput, kind, toolName);
    if (verdict.kind === 'foreign') return stop('foreign_tool', describeFixerStop(verdict.title, rawInput), rawInput, this.eventKind);
    if (verdict.kind === 'step') {
      const strict = verdict.tool === 'fs_write' && (toolName !== undefined || EDITING_TITLE.test(title));
      const bad = this.argsOutcome(verdict.tool, rawInput, strict);
      if (bad !== null) return bad;
      if (strict) this.strict.add(id);
      if (hasInput(rawInput)) this.judged.add(id);
    }
    this.accepted.set(id, verdict.kind === 'step' ? { kind: 'step', tool: verdict.tool } : { kind: 'load', tools: verdict.tools });
    this.calls += 1;
    if (verdict.kind === 'step' && verdict.tool === 'fs_write') this.writeCalls += 1;
    return { kind: 'step' };
  }

  /** A later event of an accepted call: the same tool, and arguments (when it carries some) that are understood. */
  private again(id: string, known: Accepted, title: string | null | undefined, rawInput: unknown, status?: string, toolName?: string, isUpdate = false): GuardOutcome {
    // An update keeps the tool of its id whatever its title or `_meta` say (the call was judged once; kiro-cli changes
    // the title of a running call, and may leave `_meta` out). Its title must still be one clean line, and the input it
    // carries is judged again below. A repeated `tool_call` must name the same tool.
    const titleOk = isUpdate ? title === null || title === undefined || title === '' || PLAIN_TITLE.test(title) : true;
    if (!titleOk || !isSameFixerCall(known, isUpdate ? null : title, rawInput, isUpdate ? undefined : toolName)) {
      return stop('foreign_tool', describeFixerStop(title ?? '', rawInput), rawInput, this.eventKind);
    }
    if (known.kind === 'load') return { kind: 'pass' };
    const bad = this.argsOutcome(known.tool, rawInput, this.strict.has(id));
    if (bad !== null) return bad;
    if (hasInput(rawInput)) this.judged.add(id);
    // Fail closed: a file tool that runs (any status past `pending`) must have had its arguments judged by then.
    if (status !== undefined && status !== 'pending' && !this.judged.has(id)) {
      return stop('unjudged_input', `${known.tool} ran (${status.slice(0, 20)}) with arguments never seen`, rawInput, this.eventKind);
    }
    return { kind: 'pass' };
  }

  /** Judges one stream event. `step`: a new call to count; `pass`: nothing to do; `stop`: stop the process group. */
  judge(ev: HuntStreamEvent): GuardOutcome {
    this.eventKind = ev.type === 'tool_call' ? ev.kind : undefined;
    if (ev.type === 'tool_call') {
      const known = this.accepted.get(ev.id);
      return known !== undefined ? this.again(ev.id, known, ev.title, ev.rawInput, undefined, ev.toolName) : this.accept(ev.id, ev.title, ev.rawInput, ev.kind, ev.toolName);
    }
    if (ev.type === 'tool_call_update') {
      const known = this.accepted.get(ev.id);
      if (known !== undefined) return this.again(ev.id, known, ev.title, ev.rawInput, ev.status, ev.toolName, true);
      // An update of a call that was never announced. With no title it names nothing the guard could judge, so it is
      // refused; with a title it is judged like a new call, and counted.
      if (ev.title === null || ev.title === undefined || ev.title === '') return stop('unknown_update', 'update of an unknown call', ev.rawInput);
      return this.accept(ev.id, ev.title, ev.rawInput, undefined, ev.toolName);
    }
    return { kind: 'pass' };
  }
}

export const fixerToolNames: readonly string[] = FIXER_TOOLS;
