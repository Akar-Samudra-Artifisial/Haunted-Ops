import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEPT_META, MAX_FINAL_TEXT, MAX_INPUT_CHARS, idMapper, reviewChecklist, sanitizeLedger, sanitizeStream, scrub } from './sanitize-hunt-stream.mjs';

const line = (o) => JSON.stringify(o);
const ev = (update, sessionId = 'real-session-0001') => ({ type: 'sessionUpdate', data: { sessionId, update } });

const RAW = [
  line({ type: 'runStarted', data: { who: 'somebody', machine: 'macbook.local' } }),
  line(ev({ sessionUpdate: 'tool_call', toolCallId: 'tc-aaa', title: '@exorcist/query_metrics', kind: 'other', rawInput: { service: 'payments', note: '/Users/somebody/Project/x' } })),
  line(ev({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-aaa', status: 'completed', content: [{ text: 'secret result' }] })),
  line(ev({ sessionUpdate: 'tool_call', toolCallId: 'tc-bbb', title: '@exorcist/diff_commit', kind: 'other', rawInput: { sha: '65c0fca' } })),
  line(ev({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Culprit is d-7. Mail me at someone@example.com, token ghp_abcdefghijklmnop1234 on host box.local.' } })),
  line(ev({ sessionUpdate: 'session_info_update', _meta: { kiro: { credits: [{ unit: 'credit', usage: 0.58812345 }], elapsedTime: 25.2012, stopReason: 'end_turn', accountId: '123456789012', breakdown: { tools: {} } } } })),
  line(ev({ sessionUpdate: 'session_info_update', _meta: { kiro: { contextUsage: 0.2, usagePercentage: 4, kind: 'x' } } })),
  'not json at all',
  line({ type: 'runFinished', data: { status: 'success', stopReason: 'end_turn', email: 'me@example.com' } }),
].join('\n');

test('keeps only what the runner reads and renumbers ids', () => {
  const r = sanitizeStream(RAW);
  const events = r.text.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events.some((e) => e.type === 'runStarted'), false);
  const calls = events.filter((e) => e.data.update?.sessionUpdate === 'tool_call');
  assert.deepEqual(calls.map((e) => e.data.update.toolCallId), ['call-1', 'call-2']);
  assert.deepEqual(new Set(events.map((e) => e.data.sessionId).filter(Boolean)), new Set(['session-1']));
  const done = events.find((e) => e.data.update?.status === 'completed');
  assert.deepEqual(Object.keys(done.data.update).sort(), ['sessionUpdate', 'status', 'toolCallId']);
  assert.equal(r.text.includes('secret result'), false);
  const info = events.find((e) => e.data.update?.sessionUpdate === 'session_info_update');
  assert.deepEqual(Object.keys(info.data.update._meta.kiro).sort(), [...KEPT_META].sort());
  assert.equal(info.data.update._meta.kiro.credits[0].usage, 0.588);
  assert.equal(r.dropped >= 3, true);
  // The context-usage event had no key the runner reads, so it is gone.
  assert.equal(events.filter((e) => e.data.update?.sessionUpdate === 'session_info_update').length, 1);
  assert.equal(events.at(-1).type, 'runFinished');
  assert.deepEqual(events.at(-1).data, { status: 'success', stopReason: 'end_turn' });
});

test('drops the agent message by default and keeps it, scrubbed, only when asked', () => {
  const dropped = sanitizeStream(RAW);
  assert.equal(dropped.text.includes('agent_message_chunk'), false);
  assert.equal(dropped.text.includes('Culprit is d-7'), false);
  assert.match(reviewChecklist(dropped), /message chunks/);
  const kept = sanitizeStream(RAW, { keepMessages: true });
  assert.equal(kept.text.includes('agent_message_chunk'), true);
  assert.equal(kept.text.includes('Culprit is d-7'), true);
  assert.equal(kept.text.includes('someone@example.com'), false);
});

test('removes paths, e-mails, tokens, hosts, ids and account numbers everywhere', () => {
  const r = sanitizeStream(RAW, { keepMessages: true });
  for (const bad of ['somebody', '/Users', 'example.com', 'ghp_', 'box.local', 'macbook', '123456789012', 'real-session']) {
    assert.equal(r.text.includes(bad), false, bad);
  }
  assert.ok(r.found.get('email address') >= 1);
  assert.ok(r.found.get('home path') >= 1);
  assert.ok(r.found.get('github token') >= 1);
  assert.match(reviewChecklist(r), /scrubbed: .*email address/);
});

test('scrub patterns', () => {
  const cases = [
    ['Authorization: Bearer abcdef1234567890', 'Bearer [redacted]'],
    ['/home/someone/work/file.ts', '[path]'],
    ['C:\\Users\\Someone\\x.txt', '[path]'],
    ['/private/var/folders/ab/cd/T/x', '[path]'],
    ['id 3f2504e0-4f89-11d3-9a0c-0305e82c3301', '[id]'],
    ['10.20.30.40', '[ip]'],
    ['host db.corp', '[host]'],
    ['\u001b[31mred\u001b[0m', 'red'],
    ['-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----', '[token]'],
  ];
  for (const [input, expected] of cases) assert.ok(scrub(input).includes(expected), input);
  assert.equal(scrub('http://127.0.0.1:4100/lab'), 'http://127.0.0.1:4100/lab');
});

test('caps the final message and long tool inputs, and survives garbage', () => {
  const long = 'x'.repeat(MAX_FINAL_TEXT * 3);
  const r = sanitizeStream([line(ev({ sessionUpdate: 'agent_message_chunk', content: { text: long } })), line(ev({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 't', rawInput: { big: 'y'.repeat(MAX_INPUT_CHARS + 1000) } })), '', '[]', '42', 'null'].join('\n'), { keepMessages: true });
  const events = r.text.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events.find((e) => e.data.update?.sessionUpdate === 'agent_message_chunk').data.update.content.text.length, MAX_FINAL_TEXT);
  assert.deepEqual(events.find((e) => e.data.update?.sessionUpdate === 'tool_call').data.update.rawInput, { truncated: true });
  assert.equal(sanitizeStream('').text, '\n');
});

test('keeps a full submit_diagnosis input, and keeps it equal to the sanitized ledger diagnosis', () => {
  const input = {
    service: 'payments',
    culprit_deploy: 'd-7',
    culprit_sha: '65c0fca31d0df62c4bab40d2d854c81b1044c650',
    summary: 'See /Users/someone/lab/x.ts and mail me@example.com. '.repeat(3),
    evidence: Array.from({ length: 10 }, (_, i) => ({ kind: 'log', ref: `log:${i + 1}`, detail: 'd'.repeat(280) })),
    fix_hint: 'f'.repeat(590),
  };
  assert.ok(JSON.stringify(input).length < MAX_INPUT_CHARS);
  const stream = sanitizeStream(line(ev({ sessionUpdate: 'tool_call', toolCallId: 'x', title: '@exorcist/submit_diagnosis', rawInput: input })));
  const call = JSON.parse(stream.text.trim());
  const ledger = sanitizeLedger(line({ type: 'diagnosis', seq: 9, input, at: '2026-11-13T10:00:00.000Z' }) + '\n{torn');
  const diag = JSON.parse(ledger.text.trim());
  assert.deepEqual(call.data.update.rawInput, diag.input);
  assert.equal(JSON.stringify(diag).includes('/Users'), false);
  assert.equal(JSON.stringify(diag).includes('example.com'), false);
  assert.equal(ledger.dropped, 1);
  assert.equal(diag.seq, 9);
});

test('idMapper is stable and ordered', () => {
  const m = idMapper('x');
  assert.deepEqual([m('b'), m('a'), m('b')], ['x-1', 'x-2', 'x-1']);
  assert.equal(m(undefined), undefined);
});
