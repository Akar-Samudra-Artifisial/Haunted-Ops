import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SCHEMA_DERIVED, inputShape, isSchemaDerived, report, shapesOf, toolOf } from './fixer-stream-shapes.mjs';

const call = (id, title, rawInput) => JSON.stringify({ type: 'sessionUpdate', data: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: id, title, rawInput } } });
const upd = (id, extra) => JSON.stringify({ type: 'sessionUpdate', data: { sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: id, ...extra } } });
const STREAM = [
  call('a', 'Tool Call', { tool_id: 'tool::builtin::fs_read', arguments: { operations: [{ mode: 'Line', path: 'secret/path.js' }, { mode: 'Directory', path: '.', depth: 2 }] } }),
  upd('a', { title: null, status: 'completed' }),
  call('b', 'fs_write', { command: 'create', path: 'x.js', file_text: 'TEXT-MUST-NOT-APPEAR' }),
  upd('b', { status: 'in_progress' }),
  call('c', 'Tool Load', { id: 'tool::builtin::fs_write' }),
  call('d', 'fs_write', { command: 'create', path: 'y.js', file_text: 'more' }),
].join('\n');

test('toolOf reads direct titles and the wrapper', () => {
  assert.equal(toolOf('Read', {}), 'fs_read');
  assert.equal(toolOf('Tool Call', { tool_id: 'fs_write', arguments: {} }), 'fs_write');
  assert.equal(toolOf('Tool Load', { id: 'fs_write' }), null);
  assert.equal(toolOf('shell', {}), null);
});

test('inputShape lists keys, operation modes and the write command, never values', () => {
  assert.equal(inputShape('fs_write', { command: 'create', path: 'p', file_text: 't' }), 'keys[command,file_text,path] command=create');
  assert.equal(inputShape('fs_read', { operations: [{ mode: 'Line', path: 'p' }] }), 'keys[operations] operations[Line:mode,path]');
});

test('the report names titles, input shapes and update shapes with counts only', () => {
  const lines = report(shapesOf(STREAM));
  const text = lines.join('\n');
  assert.ok(text.includes('title "Tool Call" x1'));
  assert.ok(text.includes('title "fs_write" x2'));
  assert.ok(text.includes('input wrapper[arguments,tool_id] keys[operations] operations[Directory:depth,mode,path | Line:mode,path] x1'));
  assert.ok(text.includes('fs_read update title=null status=completed x1'));
  assert.ok(text.includes('fs_write update title=absent status=in_progress x1'));
  for (const value of ['secret/path.js', 'TEXT-MUST-NOT-APPEAR', 'x.js']) assert.ok(!text.includes(value), value);
});

test('the batch read shape of kiro-cli 3.3.0 (dynamic title, operations, toolName) is counted with no file name', () => {
  const line = JSON.stringify({
    type: 'sessionUpdate',
    data: {
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'r',
        title: 'Reading secretfile.ts:1',
        kind: 'read',
        rawInput: { operations: [{ mode: 'Line', path: 'services/p/src/secretfile.ts' }] },
        _meta: { kiro: { toolName: 'read' } },
      },
    },
  });
  assert.equal(toolOf('Reading a.ts:1', {}, 'read', undefined), 'fs_read');
  assert.equal(toolOf('Reading a.ts:1', {}, 'edit', undefined), null);
  assert.equal(toolOf('anything', {}, undefined, 'write'), 'fs_write');
  const text = report(shapesOf(line)).join('\n');
  assert.ok(text.includes('title "Reading <file>:<line> toolName=read" x1'));
  assert.ok(text.includes('input keys[operations] operations[Line:mode,path] x1'));
  assert.ok(!text.includes('secretfile'));
});
test('the dynamic edit shape of kiro-cli 3.3.0 (Editing title, strReplace command, toolName) is counted with no file name', () => {
  const line = JSON.stringify({
    type: 'sessionUpdate',
    data: {
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'e',
        title: 'Editing secretfile.ts',
        kind: 'edit',
        rawInput: { command: 'strReplace', path: 'services/p/src/secretfile.ts', oldStr: 'OLD-TEXT', newStr: 'NEW-TEXT' },
        _meta: { kiro: { toolName: 'write' } },
      },
    },
  });
  assert.equal(toolOf('Editing a.ts', {}, 'edit', undefined), 'fs_write');
  assert.equal(toolOf('Editing a.ts', {}, 'read', undefined), null);
  const text = report(shapesOf(line)).join('\n');
  assert.ok(text.includes('title "Editing <file> toolName=write" x1'));
  assert.ok(text.includes('input keys[command,newStr,oldStr,path] command=strReplace x1'));
  for (const value of ['secretfile', 'OLD-TEXT', 'NEW-TEXT']) assert.ok(!text.includes(value), value);
});

test('the schema-derived fixtures are listed, exist, and are marked as not recorded (task 22)', () => {
  const dir = fileURLToPath(new URL('../apps/api/test/fixtures/fixer-streams/', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.stream.jsonl'));
  for (const name of SCHEMA_DERIVED) assert.ok(files.includes(name), name);
  assert.ok(isSchemaDerived('/any/where/write-create.stream.jsonl'));
  // The recordings are never on the list.
  for (const name of ['live-fix-first-call', 'probe-replace', 'probe-create', 'read-operations', 'edit-command']) assert.ok(!isSchemaDerived(`${name}.stream.jsonl`), name);
  const shapes = report(shapesOf(readFileSync(join(dir, 'write-insert-line.stream.jsonl'), 'utf8'))).join('\n');
  assert.ok(shapes.includes('input keys[command,content,insertLine,path] command=insert x1'));
  const dirShapes = report(shapesOf(readFileSync(join(dir, 'read-directory.stream.jsonl'), 'utf8'))).join('\n');
  assert.ok(dirShapes.includes('operations[Directory:depth,exclude_patterns,mode,path]'));
});
test('an empty stream reports no call', () => {
  assert.deepEqual(report(shapesOf('')).slice(0, 2), ['fs_read:', '  (no call)']);
});
