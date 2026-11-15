#!/usr/bin/env node
// Prints the distinct title shapes and `rawInput` key sets of the `fs_read` and `fs_write` calls of a fixer stream,
// so the shapes of `kiro-cli` can be pinned in the design (task 10.1 of fix-proposal-flow).
//
//   node scripts/fixer-stream-shapes.mjs <fixer.stream.jsonl>
//
// It reads a raw or a sanitized stream and prints names and counts only: no path, no file text, no value.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const TOOL_ID = /^(?:tool::builtin::)?(fs_read|fs_write)$/;
const DIRECT = new Map([
  ['fs_read', 'fs_read'],
  ['fs_write', 'fs_write'],
  ['Read', 'fs_read'],
  ['Write', 'fs_write'],
]);

/** The file tool a `tool_call` names (directly or through the `Tool Call` wrapper), or null. */
export function toolOf(title, rawInput, kind, toolName) {
  if (toolName === 'read') return 'fs_read';
  if (toolName === 'write') return 'fs_write';
  if (DIRECT.has(title)) return DIRECT.get(title);
  if (kind === 'read' && /^Reading .+$/.test(title)) return 'fs_read';
  if (kind === 'edit' && /^Editing .+$/.test(title)) return 'fs_write';
  if (title === 'Tool Call' && isRecord(rawInput) && typeof rawInput.tool_id === 'string') return TOOL_ID.exec(rawInput.tool_id)?.[1] ?? null;
  return null;
}

const keysOf = (v) => (isRecord(v) ? Object.keys(v).sort().join(',') : typeof v);

/** The shape of one input: its top-level keys, and the keys of each `operations[]` entry. */
export function inputShape(tool, rawInput) {
  const wrapped = isRecord(rawInput) && 'arguments' in rawInput && isRecord(rawInput.arguments);
  const args = wrapped ? rawInput.arguments : rawInput;
  const parts = wrapped ? [`wrapper[${keysOf(rawInput)}]`, `keys[${keysOf(args)}]`] : [`keys[${keysOf(args)}]`];
  if (isRecord(args) && Array.isArray(args.operations)) {
    const ops = [...new Set(args.operations.map((op) => `${isRecord(op) && typeof op.mode === 'string' ? op.mode : '-'}:${keysOf(op)}`))].sort();
    parts.push(`operations[${ops.join(' | ')}]`);
  }
  if (tool === 'fs_write' && isRecord(args) && typeof args.command === 'string') parts.push(`command=${args.command}`);
  return parts.join(' ');
}

/** Counts of the shapes in the text of a stream. */
export function shapesOf(text) {
  const titles = new Map(); // tool -> Map(title -> n)
  const inputs = new Map(); // tool -> Map(shape -> n)
  const updates = new Map(); // `title|null|status` of updates -> n
  const calls = new Map(); // toolCallId -> tool
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  const nested = (m, tool, k) => {
    if (!m.has(tool)) m.set(tool, new Map());
    bump(m.get(tool), k);
  };
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      continue;
    }
    const u = isRecord(ev) && isRecord(ev.data) && isRecord(ev.data.update) ? ev.data.update : null;
    if (u === null) continue;
    if (u.sessionUpdate === 'tool_call') {
      const title = typeof u.title === 'string' ? u.title : '(none)';
      const meta = isRecord(u._meta) && isRecord(u._meta.kiro) ? u._meta.kiro : {};
      const toolName = typeof meta.toolName === 'string' ? meta.toolName : undefined;
      const tool = toolOf(title, u.rawInput, u.kind, toolName);
      if (tool === null) continue;
      if (typeof u.toolCallId === 'string') calls.set(u.toolCallId, tool);
      // A dynamic title carries a file name: only its shape is counted. The stable tool name is counted with it.
      nested(titles, tool, `${/^Reading .+$/.test(title) ? 'Reading <file>:<line>' : /^Editing .+$/.test(title) && u.kind === 'edit' ? 'Editing <file>' : title}${toolName === undefined ? '' : ` toolName=${toolName.replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, 30)}`}`);
      nested(inputs, tool, inputShape(tool, u.rawInput));
    } else if (u.sessionUpdate === 'tool_call_update' && calls.has(u.toolCallId)) {
      const title = u.title === null ? 'null' : typeof u.title === 'string' ? u.title : 'absent';
      bump(updates, `${calls.get(u.toolCallId)} update title=${title} status=${typeof u.status === 'string' ? u.status : 'unknown'}`);
    }
  }
  return { titles, inputs, updates };
}

/** The report, as lines of text. */
export function report(shapes) {
  const lines = [];
  for (const tool of ['fs_read', 'fs_write']) {
    lines.push(`${tool}:`);
    const t = shapes.titles.get(tool);
    const i = shapes.inputs.get(tool);
    if (t === undefined || i === undefined) {
      lines.push('  (no call)');
      continue;
    }
    for (const [k, n] of [...t].sort()) lines.push(`  title ${JSON.stringify(k)} x${n}`);
    for (const [k, n] of [...i].sort()) lines.push(`  input ${k} x${n}`);
  }
  lines.push('updates:');
  for (const [k, n] of [...shapes.updates].sort()) lines.push(`  ${k} x${n}`);
  if (shapes.updates.size === 0) lines.push('  (none)');
  return lines;
}

/**
 * Fixtures of `apps/api/test/fixtures/fixer-streams/` that are SCHEMA-DERIVED, NOT RECORDED (task 22): written from the
 * tool schema inside kiro-cli 3.3.0 (`write`: `create`, `strReplace`, `insert`; `read`: `Line`, `Directory`, `Image`) and
 * cleaned with `sanitize-fixer-stream.mjs`. No real run made them, so nobody should read them as what the CLI sends.
 * The recorded ones are the other files of that folder.
 */
export const SCHEMA_DERIVED = Object.freeze([
  'write-create.stream.jsonl',
  'write-insert-line.stream.jsonl',
  'write-insert-append.stream.jsonl',
  'str-replace-all.stream.jsonl',
  'read-directory.stream.jsonl',
  'read-image.stream.jsonl',
  'update-new-title.stream.jsonl',
  'update-no-meta.stream.jsonl',
]);
/** True for a file name (or path) in `SCHEMA_DERIVED`. */
export const isSchemaDerived = (file) => SCHEMA_DERIVED.includes(basename(file));
function main(argv) {
  if (argv.length !== 1) {
    process.stderr.write('usage: fixer-stream-shapes.mjs <fixer.stream.jsonl>\n');
    return 2;
  }
  const origin = isSchemaDerived(argv[0]) ? 'schema-derived, not recorded' : 'recorded or other';
  process.stdout.write(`(${origin})\n${report(shapesOf(readFileSync(argv[0], 'utf8'))).join('\n')}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
