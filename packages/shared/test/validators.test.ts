import { describe, expect, it } from 'vitest';
import {
  formatEventId,
  formatSseFrame,
  parseEventId,
  parseSseFrame,
  validateHauntLevel,
  validateIngestStatus,
  validateServiceState,
  validateServiceStates,
  validateSseEvent,
} from '../src/index.js';

const valid = {
  name: 'payments',
  room: { x: 0, y: 1 },
  hauntLevel: 3,
  reason: { kind: 'error_rate', value: 0.5 },
  metrics: { errorRate: 0.5, p95Ms: null, up: 1, at: '2026-11-12T10:00:00.000Z' },
  openIncident: { id: 'inc1', openedAt: '2026-11-12T10:00:00.000Z', peakLevel: 3 },
  updatedAt: '2026-11-12T10:00:00.000Z',
  hunt: null,
};
const calm = { ...valid, hauntLevel: 0, reason: null, metrics: null, openIncident: null };

describe('validateServiceState', () => {
  it('accepts a valid state', () => {
    expect(validateServiceState(valid)).toEqual({ ok: true, value: valid });
  });

  it('accepts null reason, metrics and incident', () => {
    expect(validateServiceState(calm).ok).toBe(true);
  });

  it('rejects a bad reason, metrics and incident', () => {
    expect(validateServiceState({ ...valid, reason: { kind: 'fog', value: 1 } }).ok).toBe(false);
    expect(validateServiceState({ ...valid, reason: { kind: 'down', value: Number.NaN } }).ok).toBe(false);
    expect(validateServiceState({ ...valid, metrics: { errorRate: 'x', p95Ms: null, up: null, at: valid.updatedAt } }).ok).toBe(false);
    expect(validateServiceState({ ...valid, openIncident: { id: '', openedAt: valid.updatedAt, peakLevel: 9 } }).ok).toBe(false);
    const { reason: _r, ...missing } = valid;
    expect(validateServiceState(missing)).toEqual({ ok: false, errors: ['$.reason'] });
  });

  it('reports each failing path', () => {
    const r = validateServiceState({ name: 'cellar', room: { x: 1.5 }, hauntLevel: 5, updatedAt: 'yesterday', extra: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toEqual(
        expect.arrayContaining(['$.name', '$.room.x', '$.room.y', '$.hauntLevel', '$.updatedAt', '$.extra']),
      );
    }
  });

  it('does not throw on hostile input', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('boom');
        },
      },
    );
    expect(validateServiceState(hostile)).toEqual({ ok: false, errors: ['$'] });
    expect(validateServiceState(null).ok).toBe(false);
  });

  it('validates arrays element by element', () => {
    const r = validateServiceStates([valid, { ...valid, hauntLevel: -1 }]);
    expect(r).toEqual({ ok: false, errors: ['$[1].hauntLevel'] });
    expect(validateServiceStates('nope')).toEqual({ ok: false, errors: ['$'] });
  });
});

describe('event payloads added for the scene', () => {
  const at = '2026-11-12T10:00:00.000Z';
  it('service.updated carries previousLevel', () => {
    expect(validateSseEvent('service.updated', { service: valid, previousLevel: 1 }).ok).toBe(true);
    expect(validateSseEvent('service.updated', { service: valid }).ok).toBe(false);
    expect(validateSseEvent('service.updated', { service: valid, previousLevel: 5 }).ok).toBe(false);
  });
  it('incident.opened carries level and reason', () => {
    const opened = { incidentId: 'i1', service: 'payments', openedAt: at, level: 2, reason: { kind: 'error_rate', value: 0.25 } };
    expect(validateSseEvent('incident.opened', opened).ok).toBe(true);
    expect(validateSseEvent('incident.opened', { ...opened, reason: null }).ok).toBe(true);
    expect(validateSseEvent('incident.opened', { incidentId: 'i1', service: 'payments', openedAt: at }).ok).toBe(false);
    expect(validateSseEvent('incident.opened', { ...opened, level: 7 }).ok).toBe(false);
    expect(validateSseEvent('incident.opened', { ...opened, reason: { kind: 'fog', value: 1 } }).ok).toBe(false);
  });
});

describe('ingest events', () => {
  const sample = { service: 'gate', errorRate: 0, p95Ms: null, up: 1 };
  it('validates ingest.polled', () => {
    expect(validateSseEvent('ingest.polled', { at: valid.updatedAt, samples: [sample] }).ok).toBe(true);
    expect(validateSseEvent('ingest.polled', { at: valid.updatedAt, samples: [{ ...sample, service: 'cellar' }] }).ok).toBe(false);
    expect(validateSseEvent('ingest.polled', { at: valid.updatedAt, samples: 'x' }).ok).toBe(false);
    expect(validateSseEvent('ingest.polled', { at: valid.updatedAt, samples: [{ ...sample, up: Number.NaN }] }).ok).toBe(false);
  });
  it('validates ingest.status and the status object', () => {
    expect(validateSseEvent('ingest.status', { state: 'stale', at: valid.updatedAt, lastSuccessAt: null }).ok).toBe(true);
    expect(validateSseEvent('ingest.status', { state: 'unknown', at: valid.updatedAt, lastSuccessAt: null }).ok).toBe(false);
    expect(validateIngestStatus({ state: 'ok', at: valid.updatedAt, lastSuccessAt: valid.updatedAt }).ok).toBe(true);
    expect(validateIngestStatus({ state: 'ok', at: valid.updatedAt }).ok).toBe(false);
  });
});

describe('validateHauntLevel', () => {
  it('accepts 0 to 4 only', () => {
    for (const v of [0, 1, 2, 3, 4]) expect(validateHauntLevel(v).ok).toBe(true);
    for (const v of [-1, 5, 2.5, '2', null, Number.NaN]) expect(validateHauntLevel(v).ok).toBe(false);
  });
});

describe('validateSseEvent', () => {
  it('validates known events and rejects unknown names', () => {
    expect(validateSseEvent('resync', { reason: 'ahead' }).ok).toBe(true);
    expect(validateSseEvent('resync', { reason: 'later' }).ok).toBe(false);
    expect(validateSseEvent('hunt.paused', {})).toEqual({ ok: false, errors: ['name'] });
    expect(validateSseEvent('hunt.started', {}).ok).toBe(false);
  });
});

describe('event ids', () => {
  it('round-trips <bootId>-<seq> and rejects anything else', () => {
    expect(parseEventId(formatEventId('a1b2c3d4e5f6', 42))).toEqual({ bootId: 'a1b2c3d4e5f6', seq: 42 });
    for (const bad of ['42', 'a1b2c3d4e5f6', 'A1B2C3D4E5F6-1', 'a1b2c3d4e5f6--1', 'a1b2c3d4e5f6-1.5', 'zzzzzzzzzzzz-1', 7, null]) {
      expect(parseEventId(bad)).toBeNull();
    }
  });

  it('validates the connected payload', () => {
    expect(validateSseEvent('connected', { bootId: 'a1b2c3d4e5f6' }).ok).toBe(true);
    expect(validateSseEvent('connected', { bootId: 'nope' }).ok).toBe(false);
    expect(validateSseEvent('resync', { reason: 'restarted' }).ok).toBe(true);
  });
});

describe('SSE wire format', () => {
  it('formats domain and control frames', () => {
    expect(formatSseFrame({ id: 'a1b2c3d4e5f6-7', event: 'heartbeat', data: { at: 'x' } })).toBe(
      'id: a1b2c3d4e5f6-7\nevent: heartbeat\ndata: {"at":"x"}\n\n',
    );
    expect(formatSseFrame({ event: 'resync', data: { reason: 'ahead' } })).toBe(
      'event: resync\ndata: {"reason":"ahead"}\n\n',
    );
  });

  it('rejects malformed frames', () => {
    expect(parseSseFrame('event: x\n\n')).toBeNull();
    expect(parseSseFrame('id: \nevent: x\ndata: 1\n\n')).toBeNull();
    expect(parseSseFrame('event: x\ndata: {nope\n\n')).toBeNull();
  });
});
