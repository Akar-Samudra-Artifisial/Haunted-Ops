#!/usr/bin/env node
// Sanitizes a recorded `kiro-cli ... --output-format stream-json` run into a fixture that is safe to
// commit. It keeps only what the Hunt runner reads, renumbers ids, removes anything that could
// identify a person or a machine, and prints a checklist for the human review that must follow.
//
//   node tools/sanitize-replay/sanitize-hunt-stream.mjs [--keep-messages] <in.jsonl> <out.jsonl>
//
// The agent's own messages (`agent_message_chunk`) are dropped: they are free text, and a fixture needs
// the tool calls and the Credits only. `--keep-messages` keeps the final message, scrubbed, for a review.
//
// The input is read as untrusted text and is never executed. Nothing is written to the network.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** What the Hunt runner reads from `_meta.kiro`; every other key is dropped. */
export const KEPT_META = ['credits', 'elapsedTime', 'stopReason'];
/** Longest text kept from the agent's final message. */
export const MAX_FINAL_TEXT = 1200;
/** Longest tool input kept, in serialized characters (a full `submit_diagnosis` is about 5 KB). */
export const MAX_INPUT_CHARS = 8000;

/** Patterns that must not survive. Each is replaced; the review prints how many were found. */
export const SCRUBBERS = [
  { name: 'bearer value', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, to: 'Bearer [redacted]' },
  { name: 'email address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, to: '[email]' },
  { name: 'home path', re: /(?:\/Users|\/home)\/[^\s"'\\/]+(?:\/[^\s"'\\]*)?/g, to: '[path]' },
  { name: 'temp path', re: /\/(?:private\/)?(?:var\/folders|tmp)\/[^\s"'\\]*/g, to: '[path]' },
  { name: 'windows path', re: /[A-Za-z]:\\Users\\[^\s"']*/g, to: '[path]' },
  { name: 'github token', re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g, to: '[token]' },
  { name: 'aws key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/g, to: '[token]' },
  { name: 'api key', re: /\b(?:sk|pk|key|tok)-[A-Za-z0-9_-]{16,}\b/g, to: '[token]' },
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, to: '[token]' },
  { name: 'uuid', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, to: '[id]' },
  { name: 'account id', re: /\b\d{12}\b/g, to: '[id]' },
  { name: 'ip address', re: /\b(?!127\.0\.0\.1\b)\d{1,3}(?:\.\d{1,3}){3}\b/g, to: '[ip]' },
  { name: 'hostname', re: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:local|lan|internal|corp|home)\b/gi, to: '[host]' },
  // eslint-disable-next-line no-control-regex
  { name: 'ansi escape', re: /\u001b\[[0-?]*[ -/]*[@-~]/g, to: '' },
];

/** Applies every scrubber; `found` counts the hits per scrubber name. */
export function scrub(text, found = new Map()) {
  let out = text;
  for (const { name, re, to } of SCRUBBERS) {
    out = out.replace(re, () => {
      found.set(name, (found.get(name) ?? 0) + 1);
      return to;
    });
  }
  return out;
}

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Maps each distinct real id to a stable `<prefix>-N`, in order of first appearance. */
export function idMapper(prefix) {
  const seen = new Map();
  return (id) => {
    if (typeof id !== 'string' || id === '') return id;
    if (!seen.has(id)) seen.set(id, `${prefix}-${seen.size + 1}`);
    return seen.get(id);
  };
}

/** Rounds a timestamp-like number to the second, so a recording cannot be matched to a moment. */
const roundNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);

function scrubValue(value, found, depth = 0) {
  if (depth > 8) return null;
  if (typeof value === 'string') return scrub(value, found);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubValue(v, found, depth + 1));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).slice(0, 50).map(([k, v]) => [k, scrubValue(v, found, depth + 1)]));
  return value;
}

function keepMeta(meta) {
  if (!isRecord(meta) || !isRecord(meta.kiro)) return undefined;
  const kiro = {};
  for (const key of KEPT_META) if (meta.kiro[key] !== undefined) kiro[key] = roundNumber(meta.kiro[key]);
  if (Array.isArray(kiro.credits)) kiro.credits = kiro.credits.map((c) => (isRecord(c) ? { unit: typeof c.unit === 'string' ? c.unit : 'credit', usage: roundNumber(c.usage) } : c));
  return { kiro };
}

/**
 * Sanitizes the text of a whole run. Returns the new text, the counts of what was scrubbed, the
 * number of dropped lines and what the human must look at.
 */
export function sanitizeStream(text, options = {}) {
  const keepMessages = options.keepMessages === true;
  const found = new Map();
  const sessions = idMapper('session');
  const calls = idMapper('call');
  const out = [];
  let dropped = 0;
  let finalText = '';
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      dropped += 1;
      continue;
    }
    if (!isRecord(ev)) {
      dropped += 1;
      continue;
    }
    if (ev.type === 'runFinished') {
      out.push({ type: 'runFinished', data: scrubValue(isRecord(ev.data) ? { status: ev.data.status, stopReason: ev.data.stopReason } : {}, found) });
      continue;
    }
    const update = isRecord(ev.data) && isRecord(ev.data.update) ? ev.data.update : null;
    if (update === null) {
      dropped += 1;
      continue;
    }
    const kind = update.sessionUpdate;
    if (kind === 'tool_call') {
      const rawInput = scrubValue(update.rawInput ?? {}, found);
      const serialized = JSON.stringify(rawInput);
      out.push({
        type: ev.type ?? 'sessionUpdate',
        data: {
          sessionId: sessions(isRecord(ev.data) ? ev.data.sessionId : undefined),
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: calls(update.toolCallId),
            title: scrub(String(update.title ?? ''), found),
            kind: typeof update.kind === 'string' ? update.kind : 'other',
            rawInput: serialized.length > MAX_INPUT_CHARS ? { truncated: true } : rawInput,
          },
        },
      });
    } else if (kind === 'tool_call_update') {
      out.push({
        type: ev.type ?? 'sessionUpdate',
        data: {
          sessionId: sessions(isRecord(ev.data) ? ev.data.sessionId : undefined),
          update: { sessionUpdate: 'tool_call_update', toolCallId: calls(update.toolCallId), status: typeof update.status === 'string' ? update.status : 'unknown' },
        },
      });
    } else if (kind === 'session_info_update') {
      const meta = keepMeta(update._meta);
      // Context-usage, title and turn-boundary events carry nothing the runner reads: drop them.
      if (meta === undefined || Object.keys(meta.kiro).length === 0) {
        dropped += 1;
        continue;
      }
      out.push({ type: ev.type ?? 'sessionUpdate', data: { sessionId: sessions(isRecord(ev.data) ? ev.data.sessionId : undefined), update: { sessionUpdate: 'session_info_update', _meta: meta } } });
    } else if (kind === 'agent_message_chunk') {
      if (keepMessages) {
        const t = isRecord(update.content) && typeof update.content.text === 'string' ? update.content.text : '';
        finalText += t;
      } else {
        dropped += 1;
      }
    } else {
      dropped += 1;
    }
  }
  if (finalText !== '') {
    const kept = scrub(finalText, found).slice(0, MAX_FINAL_TEXT);
    // The agent's message goes just before `runFinished`, as one chunk.
    const at = out.findIndex((e) => e.type === 'runFinished');
    const msg = { type: 'sessionUpdate', data: { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: kept } } } };
    out.splice(at === -1 ? out.length : at, 0, msg);
  }
  return { text: out.map((e) => JSON.stringify(e)).join('\n') + '\n', found, dropped, lines: out.length };
}

/**
 * Sanitizes a Hunt ledger (one JSON object per line) with the same scrubbers as the stream, so a
 * diagnosis in the ledger stays equal to the `submit_diagnosis` arguments of the sanitized stream.
 * Every string value is scrubbed; keys, numbers and structure are kept. Bad lines are dropped.
 */
export function sanitizeLedger(text) {
  const found = new Map();
  const out = [];
  let dropped = 0;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const v = JSON.parse(raw);
      if (!isRecord(v)) throw new Error('not an object');
      out.push(JSON.stringify(scrubValue(v, found, 0)));
    } catch {
      dropped += 1;
    }
  }
  return { text: out.join('\n') + '\n', found, dropped, lines: out.length };
}

/** What the human reviewer must check before the fixture is committed. */
export function reviewChecklist(result) {
  const lines = ['Review before committing (a human must read the output file):'];
  lines.push(`- ${result.lines} lines kept, ${result.dropped} dropped (unknown event types, malformed lines, message chunks).`);
  const hits = [...result.found.entries()].map(([k, n]) => `${k} x${n}`);
  lines.push(`- scrubbed: ${hits.length === 0 ? 'nothing found' : hits.join(', ')}.`);
  lines.push('- read every line: no real name, e-mail, host, home path, account id, session id or token.');
  lines.push('- the agent messages were dropped (free text); with --keep-messages the final one is kept, and then it must say nothing about the machine.');
  lines.push('- run the repository secret scan before the commit.');
  return lines.join('\n');
}

function main(argv) {
  const flags = argv.filter((a) => a.startsWith('--'));
  const files = argv.filter((a) => !a.startsWith('--'));
  const ledger = flags.includes('--ledger');
  const [input, output] = files;
  if (!input || !output || files.length !== 2 || flags.some((f) => f !== '--ledger' && f !== '--keep-messages')) {
    process.stderr.write('usage: sanitize-hunt-stream.mjs [--ledger | --keep-messages] <in.jsonl> <out.jsonl>\n');
    return 2;
  }
  const text = readFileSync(input, 'utf8');
  const result = ledger ? sanitizeLedger(text) : sanitizeStream(text, { keepMessages: flags.includes('--keep-messages') });
  writeFileSync(output, result.text, { mode: 0o644 });
  process.stdout.write(`${reviewChecklist(result)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
