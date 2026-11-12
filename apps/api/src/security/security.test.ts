import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { isAllowedOrigin } from './cors.js';
import { errorCode, statusOf } from './error.filter.js';
import { JsonLogger, NestJsonLogger, pathOnly } from './logger.js';
import { isMutating } from './rate-limit.guard.js';
import { REDACTED, redact } from './redact.js';

describe('redact', () => {
  it('replaces secret-looking keys at any depth', () => {
    const input = {
      user: 'a',
      apiKey: 'k1',
      nested: { Authorization: 'Bearer x', list: [{ github_token: 't' }, { ok: 1 }] },
      cookie: 'c',
      Password: 'p',
    };
    expect(redact(input)).toEqual({
      user: 'a',
      apiKey: REDACTED,
      nested: { Authorization: REDACTED, list: [{ github_token: REDACTED }, { ok: 1 }] },
      cookie: REDACTED,
      Password: REDACTED,
    });
  });

  it('handles cycles and primitives', () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(redact(a)).toEqual({ x: 1, self: '[circular]' });
    expect(redact('plain')).toBe('plain');
    expect(redact(null)).toBeNull();
  });

  it('scrubs connection strings and URL credentials inside messages', () => {
    const msg = 'connect failed: postgresql://app:hunter2@db.internal:5432/haunted_dev (timeout)';
    expect(redact({ msg })).toEqual({ msg: 'connect failed: [redacted] (timeout)' });
    expect(redact('dial "postgres://u@h/db" refused')).toBe('dial "[redacted]" refused');
    expect(redact('fetch https://bot:ghs_abc123@api.example.test/repo failed')).toBe(
      'fetch https://[redacted]@api.example.test/repo failed',
    );
    // Plain URLs without credentials stay readable.
    expect(redact('see https://example.test/docs')).toBe('see https://example.test/docs');
  });

  it('JsonLogger scrubs a connection string in the message text', () => {
    const lines: string[] = [];
    new JsonLogger((l) => lines.push(l)).log('error', 'db error at postgres://app:pw-9f8e7d@127.0.0.1/x');
    expect(lines[0]).not.toContain('pw-9f8e7d');
    expect(lines[0]).toContain('db error at [redacted]');
  });
});

describe('JsonLogger', () => {
  it('writes one redacted JSON line', () => {
    const lines: string[] = [];
    const logger = new JsonLogger((l) => lines.push(l), () => new Date('2026-11-12T10:00:00.000Z'));
    logger.log('info', 'hello', { secretValue: 's', n: 1 });
    expect(lines).toEqual(['{"ts":"2026-11-12T10:00:00.000Z","level":"info","msg":"hello","secretValue":"[redacted]","n":1}\n']);
  });

  it('Nest adapter drops stack traces and non-string messages', () => {
    const lines: string[] = [];
    const nest = new NestJsonLogger(new JsonLogger((l) => lines.push(l)));
    nest.error('failed', 'Error: at secret/path.ts:1', 'Ctx');
    nest.log({ some: 'object with data' });
    expect(lines.join('')).not.toContain('secret/path');
    expect(lines.join('')).not.toContain('object with data');
  });
});

describe('helpers', () => {
  it('pathOnly strips query and fragment', () => {
    expect(pathOnly('/api/events?lastEventId=4&token=x')).toBe('/api/events');
    expect(pathOnly('/a#b')).toBe('/a');
    expect(pathOnly('/plain')).toBe('/plain');
  });

  it('isAllowedOrigin is exact', () => {
    expect(isAllowedOrigin('http://localhost:5173', 'http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173/', 'http://localhost:5173')).toBe(false);
    expect(isAllowedOrigin(undefined, 'http://localhost:5173')).toBe(false);
  });

  it('isMutating counts only POST, PUT, PATCH, DELETE style methods', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) expect(isMutating(m)).toBe(true);
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'get', undefined]) expect(isMutating(m)).toBe(false);
  });

  it('maps errors to status and code', () => {
    expect(statusOf(new NotFoundException())).toBe(404);
    expect(statusOf(new BadRequestException())).toBe(400);
    expect(statusOf({ status: 413, type: 'entity.too.large' })).toBe(413);
    expect(statusOf({ statusCode: 600 })).toBe(500);
    expect(statusOf(new Error('x'))).toBe(500);
    expect(errorCode(413)).toBe('payload_too_large');
    expect(errorCode(502)).toBe('internal');
    expect(errorCode(418)).toBe('error');
  });
});
