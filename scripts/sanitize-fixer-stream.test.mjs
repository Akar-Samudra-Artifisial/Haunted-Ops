import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewChecklist, relativize, sanitizeFixerStream, secretValues, workPrefixes } from './sanitize-fixer-stream.mjs';

// Built from parts so that no scan of tracked files finds a home path or a token-shaped string in this file.
const HOME = ['', 'Users', 'jane.doe'].join('/');
const WORK = `${HOME}/tmp/fix/fixer/cmproposal0000000000000001/work`;
const TOKEN = ['ghp', '_0123456789abcdefghijABCDEFGHIJ012345'].join('');
const ENV_SECRET = 'zx-plain-secret-value-98765';
const line = (o) => JSON.stringify(o);
const call = (id, title, rawInput) => line({ type: 'sessionUpdate', data: { sessionId: 'real-session-id', update: { sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'other', rawInput } } });
const update = (id, extra) => line({ type: 'sessionUpdate', data: { sessionId: 'real-session-id', update: { sessionUpdate: 'tool_call_update', toolCallId: id, ...extra } } });
const RAW = [
  call('real-call-1', 'Tool Call', { tool_id: 'tool::builtin::fs_read', arguments: { operations: [{ mode: 'Line', path: `${WORK}/services/payments/src/charge.js` }] } }),
  update('real-call-1', { status: 'completed', title: null, rawOutput: { items: [{ Text: `read ${HOME}/secret.txt` }] }, content: [{ type: 'content', content: { text: 'file body' } }] }),
  line({ type: 'sessionUpdate', data: { sessionId: 'real-session-id', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `I looked at ${HOME}/x and found ${TOKEN}` } } } }),
  call('real-call-2', 'fs_write', { command: 'str_replace', path: `${WORK}/services/payments/src/charge.js`, old_str: 'a', new_str: `b // ${HOME}/notes`, env: { GITHUB_TOKEN: TOKEN, HOME } }),
  update('real-call-2', { status: 'in_progress' }),
  call('real-call-3', 'fs_read', { operations: [{ mode: 'Directory', path: WORK }], note: `using ${ENV_SECRET} and ${TOKEN}` }),
  line({ type: 'sessionUpdate', data: { sessionId: 'real-session-id', update: { sessionUpdate: 'session_info_update', _meta: { kiro: { credits: [{ unit: 'credit', usage: 0.91234567 }], elapsedTime: 41.1, contextUsage: 12 } } } } }),
  line({ type: 'sessionUpdate', data: { sessionId: 'real-session-id', update: { sessionUpdate: 'available_commands_update', commands: [] } } }),
  'not json',
  line({ type: 'runFinished', data: { status: 'ok', stopReason: 'end_turn', cwd: WORK } }),
].join('\n');
const run = () => sanitizeFixerStream(RAW, { work: WORK, env: { MY_SECRET_VALUE: ENV_SECRET, PATH: '/usr/bin' } });

test('removes the fake home path, the fake token and the environment value', () => {
  const { text } = run();
  for (const bad of [HOME, 'jane.doe', TOKEN, ENV_SECRET, 'real-session-id', 'real-call-', 'file body']) assert.ok(!text.includes(bad), bad);
});

test('drops every agent message chunk and every other event, and counts them', () => {
  const result = run();
  assert.ok(!result.text.includes('agent_message_chunk'));
  assert.ok(!result.text.includes('available_commands_update'));
  assert.equal(result.messages, 1);
  assert.equal(result.dropped, 2);
});

test('keeps tool calls with relative paths, statuses, the null title and the Credits', () => {
  const events = run().text.trim().split('\n').map((l) => JSON.parse(l));
  const calls = events.filter((e) => e.data?.update?.sessionUpdate === 'tool_call').map((e) => e.data.update);
  assert.deepEqual(calls.map((c) => c.title), ['Tool Call', 'fs_write', 'fs_read']);
  assert.deepEqual(calls[0].rawInput, { tool_id: 'tool::builtin::fs_read', arguments: { operations: [{ mode: 'Line', path: 'services/payments/src/charge.js' }] } });
  assert.equal(calls[1].rawInput.path, 'services/payments/src/charge.js');
  assert.equal(calls[2].rawInput.operations[0].path, '.');
  assert.ok(!('env' in calls[1].rawInput));
  const updates = events.filter((e) => e.data?.update?.sessionUpdate === 'tool_call_update').map((e) => e.data.update);
  assert.deepEqual(updates.map((u) => u.status), ['completed', 'in_progress']);
  assert.equal(updates[0].title, null);
  assert.ok(!('rawOutput' in updates[0]) && !('content' in updates[0]));
  assert.equal(updates[0].toolCallId, calls[0].toolCallId);
  const meta = events.find((e) => e.data?.update?.sessionUpdate === 'session_info_update').data.update._meta.kiro;
  assert.deepEqual(meta, { credits: [{ unit: 'credit', usage: 0.912 }], elapsedTime: 41.1 });
  assert.deepEqual(events.at(-1), { type: 'runFinished', data: { status: 'ok', stopReason: 'end_turn' } });
});

test('the output is stable: sanitizing it again changes nothing', () => {
  const once = run().text;
  const twice = sanitizeFixerStream(once, { work: WORK, env: {} }).text;
  assert.equal(twice, once);
});

test('relativize leaves a longer path that only contains the folder name alone', () => {
  const prefixes = workPrefixes('/tmp/work');
  assert.equal(relativize('/tmp/work/a.js and /tmp/work', prefixes), 'a.js and .');
  assert.equal(relativize('/x/tmp/work/a.js and /tmp/workshop/b', prefixes), '/x/tmp/work/a.js and /tmp/workshop/b');
  assert.ok(workPrefixes('/tmp/work').includes('/private/tmp/work'));
});

test('secretValues keeps long values of secret-looking names only', () => {
  assert.deepEqual(secretValues({ API_TOKEN: 'abcdefghij', PATH: '/usr/bin:/bin', SHORT_KEY: 'abc', GITHUB_PASSWORD: 'longerpassword' }), ['longerpassword', 'abcdefghij']);
});

test('the checklist names counts, never values', () => {
  const text = reviewChecklist(run());
  assert.match(text, /agent message chunks removed/);
  assert.ok(!text.includes(TOKEN));
});

test('keeps the input of an update (cleaned), and with toolCallsOnly keeps only tool calls and their updates', () => {
  const raw = [
    update('real-call-9', { status: 'pending', rawInput: { path: `${WORK}/services/x/src/a.ts`, oldStr: 'a', newStr: 'b', replace_all: false } }),
    RAW,
  ].join('\n');
  const all = sanitizeFixerStream(raw, { work: WORK, env: {} });
  const first = JSON.parse(all.text.split('\n')[0]);
  assert.deepEqual(first.data.update.rawInput, { path: 'services/x/src/a.ts', oldStr: 'a', newStr: 'b', replace_all: false });
  const only = sanitizeFixerStream(raw, { work: WORK, env: {}, toolCallsOnly: true });
  const kinds = only.text.trim().split('\n').map((l) => JSON.parse(l).data.update.sessionUpdate);
  assert.ok(kinds.every((k) => k === 'tool_call' || k === 'tool_call_update'));
  assert.equal(kinds.length, 6);
  assert.ok(!only.text.includes('runFinished'));
});

test('keeps the stable tool name of a call and of an update, and nothing else of `_meta`', () => {
  const meta = { kiro: { toolName: 'read', secret: 'nope' } };
  const raw = [
    line({ type: 'sessionUpdate', data: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'c', title: 'Reading a.ts:1', kind: 'read', rawInput: { operations: [{ mode: 'Line', path: 'a.ts' }] }, _meta: meta } } }),
    update('c', { status: 'completed', title: null, _meta: meta }),
    update('c', { status: 'pending', _meta: { kiro: { toolName: { x: 1 } } } }),
  ].join('\n');
  const out = sanitizeFixerStream(raw, { work: WORK, env: {} });
  const evs = out.text.trim().split('\n').map((l) => JSON.parse(l).data.update);
  assert.deepEqual(evs[0]._meta, { kiro: { toolName: 'read' } });
  assert.deepEqual(evs[1]._meta, { kiro: { toolName: 'read' } });
  assert.equal(evs[2]._meta, undefined);
  assert.ok(!out.text.includes('nope'));
});
