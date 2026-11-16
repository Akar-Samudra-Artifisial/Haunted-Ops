#!/usr/bin/env node
// Sanitizes a raw fixer `*.stream.jsonl` (one real `kiro-cli` run of the exorcist-fixer agent) into a copy that
// is safe to commit as a fixture (task 10.1 of fix-proposal-flow).
//
//   node scripts/sanitize-fixer-stream.mjs --work <work folder> <in.jsonl> <out.jsonl>
//
// Kept: tool calls and their updates (titles, `toolCallId`, `rawInput` with every path inside the work folder made
// relative to it, statuses) and the Credits of `session_info_update`. Dropped: every agent message chunk, every
// other event, tool output, any `env` key, and any value of an environment variable that looks like a secret.
// Scrubbed: absolute home and temp paths, tokens, e-mail addresses, ids (the scrubbers of the Hunt sanitizer).
// The input is read as untrusted text and is never executed. Nothing is written to the network.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_INPUT_CHARS, dropPurpose, idMapper, keepIdentity, scrub } from '../tools/sanitize-replay/sanitize-hunt-stream.mjs';

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Keys that hold an environment and are dropped with their value, at any depth. */
const ENV_KEY = /^(?:env|envs|environment|env_vars|environ)$/i;
/** Names of environment variables whose value must never survive. */
const SECRET_NAME = /(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
/** Shortest value that is replaced by itself (a short value would damage ordinary text). */
const MIN_SECRET_LENGTH = 8;

/** The values of the secret-looking variables of `env`, longest first. */
export function secretValues(env) {
  const out = new Set();
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAME.test(name) && typeof value === 'string' && value.length >= MIN_SECRET_LENGTH) out.add(value);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** The spellings of the work folder a stream may use (as given, resolved, and with or without the macOS `/private`). */
export function workPrefixes(work) {
  const names = new Set();
  const add = (p) => {
    const clean = p.replace(/\/+$/, '');
    if (clean.startsWith('/') && clean.length > 1) names.add(clean);
  };
  add(work);
  add(resolve(work));
  try {
    add(realpathSync(work));
  } catch {
    // The folder is gone after the run: the given spellings are enough.
  }
  for (const n of [...names]) {
    if (n.startsWith('/private/')) add(n.slice('/private'.length));
    else add(`/private${n}`);
  }
  return [...names].sort((a, b) => b.length - a.length);
}

/** Replaces `<work>/x` by `x` and a bare `<work>` by `.`, wherever it stands in the text. */
export function relativize(text, prefixes) {
  let out = text;
  for (const p of prefixes) {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The folder must start a path (not sit inside a longer one) and end at a segment boundary.
    out = out.replace(new RegExp(`(?<![A-Za-z0-9._/-])${escaped}/`, 'g'), '');
    out = out.replace(new RegExp(`(?<![A-Za-z0-9._/-])${escaped}(?![A-Za-z0-9._-])`, 'g'), '.');
  }
  return out;
}

function cleanText(text, ctx) {
  let out = relativize(text, ctx.prefixes);
  for (const secret of ctx.secrets) {
    if (out.includes(secret)) {
      ctx.found.set('environment value', (ctx.found.get('environment value') ?? 0) + 1);
      out = out.split(secret).join('[token]');
    }
  }
  return scrub(out, ctx.found);
}

function cleanValue(value, ctx, depth = 0) {
  if (depth > 8) return null;
  if (typeof value === 'string') return cleanText(value, ctx);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => cleanValue(v, ctx, depth + 1));
  if (isRecord(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 50)) {
      if (ENV_KEY.test(k)) {
        ctx.found.set('env key', (ctx.found.get('env key') ?? 0) + 1);
        continue;
      }
      out[cleanText(k, ctx)] = cleanValue(v, ctx, depth + 1);
    }
    return out;
  }
  return value;
}

/** The identity of a tool event as an `_meta` to add: the stable tool name, and the server name only when it is `exorcist`. */
const keepToolName = keepIdentity;
const round = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);
function keepMeta(meta) {
  if (!isRecord(meta) || !isRecord(meta.kiro)) return undefined;
  const kiro = {};
  for (const key of ['credits', 'elapsedTime', 'stopReason']) if (meta.kiro[key] !== undefined) kiro[key] = round(meta.kiro[key]);
  if (Array.isArray(kiro.credits)) kiro.credits = kiro.credits.map((c) => (isRecord(c) ? { unit: typeof c.unit === 'string' ? c.unit : 'credit', usage: round(c.usage) } : c));
  return Object.keys(kiro).length === 0 ? undefined : { kiro };
}

/**
 * Sanitizes the text of a whole run. `options.work` is the work folder of the fixer; `options.env` holds the
 * environment whose secret-looking values must not survive (default: this process).
 * Returns the new text, what was scrubbed and the count of dropped lines.
 */
export function sanitizeFixerStream(text, options) {
  const ctx = {
    prefixes: workPrefixes(options.work),
    secrets: secretValues(options.env ?? process.env),
    found: new Map(),
  };
  const sessions = idMapper('session');
  const calls = idMapper('call');
  const out = [];
  let dropped = 0;
  let messages = 0;
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
    const kindOf = isRecord(ev.data) && isRecord(ev.data.update) ? ev.data.update.sessionUpdate : null;
    if (options.toolCallsOnly === true && kindOf !== 'tool_call' && kindOf !== 'tool_call_update') {
      // Guard fixtures keep the tool calls and their updates only.
      if (kindOf === 'agent_message_chunk') messages += 1;
      else dropped += 1;
      continue;
    }
    if (ev.type === 'runFinished') {
      const data = isRecord(ev.data) ? { status: ev.data.status, stopReason: ev.data.stopReason } : {};
      out.push({ type: 'runFinished', data: cleanValue(data, ctx) });
      continue;
    }
    const update = isRecord(ev.data) && isRecord(ev.data.update) ? ev.data.update : null;
    if (update === null) {
      dropped += 1;
      continue;
    }
    const sessionId = sessions(ev.data.sessionId);
    const kind = update.sessionUpdate;
    if (kind === 'tool_call') {
      const rawInput = cleanValue(dropPurpose(update.rawInput ?? {}), ctx);
      out.push({
        type: ev.type ?? 'sessionUpdate',
        data: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: calls(update.toolCallId),
            title: cleanText(String(update.title ?? ''), ctx),
            kind: typeof update.kind === 'string' ? update.kind : 'other',
            rawInput: JSON.stringify(rawInput).length > MAX_INPUT_CHARS ? { truncated: true } : rawInput,
            ...keepToolName(update),
          },
        },
      });
    } else if (kind === 'tool_call_update') {
      const u = { sessionUpdate: 'tool_call_update', toolCallId: calls(update.toolCallId), status: typeof update.status === 'string' ? update.status : 'unknown' };
      // A title that is null or missing stays so: the guard judges such an update by its call id (13.7).
      if (update.title === null) u.title = null;
      else if (typeof update.title === 'string') u.title = cleanText(update.title, ctx);
      // The input an update carries is judged by the guard too (kiro-cli 3.3.0 repeats it, `replace_all` added), so it
      // is kept, cleaned like a call's. The tool output (`rawOutput`, `content`) is never kept.
      if (update.rawInput !== undefined) {
        const rawInput = cleanValue(dropPurpose(update.rawInput), ctx);
        u.rawInput = JSON.stringify(rawInput).length > MAX_INPUT_CHARS ? { truncated: true } : rawInput;
      }
      Object.assign(u, keepToolName(update));
      out.push({ type: ev.type ?? 'sessionUpdate', data: { sessionId, update: u } });
    } else if (kind === 'session_info_update') {
      const meta = keepMeta(update._meta);
      if (meta === undefined) {
        dropped += 1;
        continue;
      }
      out.push({ type: ev.type ?? 'sessionUpdate', data: { sessionId, update: { sessionUpdate: 'session_info_update', _meta: meta } } });
    } else if (kind === 'agent_message_chunk') {
      messages += 1;
    } else {
      dropped += 1;
    }
  }
  return { text: out.length === 0 ? '' : out.map((e) => JSON.stringify(e)).join('\n') + '\n', found: ctx.found, dropped, messages, lines: out.length };
}

/** What the human reviewer must check before the stream is committed. */
export function reviewChecklist(result) {
  const hits = [...result.found.entries()].map(([k, n]) => `${k} x${n}`);
  return [
    'Review before committing (a human must read the output file):',
    `- ${result.lines} lines kept, ${result.dropped} dropped, ${result.messages} agent message chunks removed.`,
    `- scrubbed: ${hits.length === 0 ? 'nothing found' : hits.join(', ')}.`,
    '- read every line: no real name, e-mail, host, home path, account id, session id or token; paths are relative to the work folder.',
  ].join('\n');
}

function main(argv) {
  const args = [...argv];
  const at = args.indexOf('--work');
  const work = at === -1 ? undefined : args.splice(at, 2)[1];
  const only = args.indexOf('--tool-calls-only');
  if (only !== -1) args.splice(only, 1);
  if (work === undefined || args.length !== 2) {
    process.stderr.write('usage: sanitize-fixer-stream.mjs --work <work folder> [--tool-calls-only] <in.jsonl> <out.jsonl>\n');
    return 2;
  }
  const result = sanitizeFixerStream(readFileSync(args[0], 'utf8'), { work, toolCallsOnly: only !== -1 });
  writeFileSync(args[1], result.text, { mode: 0o644 });
  process.stdout.write(`${reviewChecklist(result)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
