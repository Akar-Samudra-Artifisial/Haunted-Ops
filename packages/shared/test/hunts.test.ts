import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DOMAIN_EVENT_NAMES,
  HUNT_EVENT_NAMES,
  shortSha,
  validateHuntDetail,
  validateHuntEvent,
  validateHuntSummary,
  validateServiceState,
  validateSseEvent,
  type HuntDetail,
  type HuntSummary,
} from '../src/index.js';
import { huntSummaryArb, serviceStateArb } from './arbitraries.js';

const SHA = '65c0fca31d0df62c4bab40d2d854c81b1044c650';
const ID = 'cmhuntaaaaaaaaaaaaaaaaaaa';
const INC = 'cmincidentaaaaaaaaaaaaaaa';

const sealed: HuntSummary = {
  id: ID,
  incidentId: INC,
  service: 'payments',
  trigger: 'auto',
  status: 'succeeded',
  reason: 'diagnosed',
  steps: [{ index: 1, tool: 'query_metrics', summary: 'metrics payments error_ratio 15m', at: '2026-11-13T10:41:00.000Z' }],
  stepCount: 5,
  evidenceCount: 9,
  diagnosis: { culpritDeploy: 'd-7', culpritSha: SHA, culpritService: 'payments', summary: 'The refund guard was removed.' },
  credits: 0.61,
  queuedAt: '2026-11-13T10:40:58.000Z',
  startedAt: '2026-11-13T10:40:59.000Z',
  finishedAt: '2026-11-13T10:41:31.000Z',
  diagnosedBy: null,
};

describe('hunt summaries', () => {
  it('accepts a sealed, a running and a failed hunt', () => {
    expect(validateHuntSummary(sealed).ok).toBe(true);
    const running: HuntSummary = { ...sealed, status: 'running', reason: null, diagnosis: null, finishedAt: null };
    expect(validateHuntSummary(running).ok).toBe(true);
    const failed: HuntSummary = { ...sealed, status: 'failed', reason: 'credit_cap', diagnosis: null };
    expect(validateHuntSummary(failed).ok).toBe(true);
  });

  it('refuses a diagnosis on a hunt that did not succeed, and a success without one', () => {
    expect(validateHuntSummary({ ...sealed, status: 'failed', reason: 'invalid_diagnosis' }).ok).toBe(false);
    expect(validateHuntSummary({ ...sealed, diagnosis: null }).ok).toBe(false);
    expect(validateHuntSummary({ ...sealed, status: 'failed', reason: 'diagnosed', diagnosis: null }).ok).toBe(false);
  });

  it('refuses an ended hunt without a reason or finish time, and a running one with them', () => {
    expect(validateHuntSummary({ ...sealed, finishedAt: null }).ok).toBe(false);
    expect(validateHuntSummary({ ...sealed, status: 'running', diagnosis: null }).ok).toBe(false);
  });

  it('bounds the fields: short SHA, bad deploy id, long summary, control characters, 9 steps, unknown keys', () => {
    const bad = (patch: Record<string, unknown>) => validateHuntSummary({ ...sealed, ...patch }).ok;
    expect(bad({ diagnosis: { ...sealed.diagnosis!, culpritSha: '65c0fca' } })).toBe(false);
    expect(bad({ diagnosis: { ...sealed.diagnosis!, culpritDeploy: 'deploy 7' } })).toBe(false);
    expect(bad({ diagnosis: { ...sealed.diagnosis!, culpritService: 'database' } })).toBe(false);
    expect(bad({ diagnosis: { culpritDeploy: 'd-7', culpritSha: SHA, summary: 'no service' } })).toBe(false);
    expect(bad({ diagnosis: { ...sealed.diagnosis!, summary: 'x'.repeat(601) } })).toBe(false);
    expect(bad({ diagnosis: { ...sealed.diagnosis!, summary: 'ok\u001b[31m' } })).toBe(false);
    expect(bad({ steps: Array.from({ length: 9 }, () => sealed.steps[0]) })).toBe(false);
    expect(bad({ stepCount: 0 })).toBe(false);
    expect(bad({ extra: 1 })).toBe(false);
    expect(bad({ id: 'Not A Cuid' })).toBe(false);
    expect(bad({ credits: -1 })).toBe(false);
  });

  it('names the Service that diagnosed a withdrawn Hunt, exactly when the reason says so', () => {
    const base: HuntSummary = { ...sealed, status: 'cancelled', reason: 'diagnosed_upstream', diagnosis: null, startedAt: null, diagnosedBy: 'payments' };
    expect(validateHuntSummary(base).ok).toBe(true);
    expect(validateHuntSummary({ ...base, diagnosedBy: null }).ok).toBe(false);
    expect(validateHuntSummary({ ...base, diagnosedBy: 'database' }).ok).toBe(false);
    expect(validateHuntSummary({ ...base, reason: 'busy' }).ok).toBe(false);
    expect(validateHuntSummary({ ...sealed, diagnosedBy: 'payments' }).ok).toBe(false);
    const finished = { huntId: ID, service: 'ledger', status: 'cancelled', reason: 'diagnosed_upstream', invalidCheck: null, diagnosedBy: 'payments', credits: 0, durationMs: 0, toolCalls: 0, finishedAt: '2026-11-13T10:41:31.000Z' };
    expect(validateHuntEvent('hunt.finished', finished).ok).toBe(true);
    expect(validateHuntEvent('hunt.finished', { ...finished, diagnosedBy: null }).ok).toBe(false);
    expect(validateHuntEvent('hunt.finished', { ...finished, reason: 'busy' }).ok).toBe(false);
    const detail: HuntDetail = { ...base, model: 'claude-sonnet-5.5', toolCalls: 0, durationMs: null, invalidCheck: null, stopDetail: null, linkedHuntId: ID, creditsEstimated: false, allSteps: [], evidence: [], fixHint: null, proposal: null };
    expect(validateHuntDetail(detail).ok).toBe(true);
    expect(validateHuntDetail({ ...detail, linkedHuntId: 'nope' }).ok).toBe(false);
    expect(validateHuntDetail({ ...detail, reason: 'busy', diagnosedBy: null }).ok).toBe(false);
  });

  it('accepts every generated summary, and a service state with or without one', () => {
    fc.assert(fc.property(huntSummaryArb, (s) => validateHuntSummary(s).ok), { numRuns: 200 });
    fc.assert(fc.property(serviceStateArb, (s) => validateServiceState(s).ok), { numRuns: 200 });
    const state = {
      name: 'payments',
      room: { x: 0, y: 1 },
      hauntLevel: 2,
      reason: null,
      metrics: null,
      openIncident: null,
      updatedAt: '2026-11-13T10:41:00.000Z',
    };
    expect(validateServiceState({ ...state, hunt: null, proposal: null }).ok).toBe(true);
    expect(validateServiceState({ ...state, hunt: sealed, proposal: null }).ok).toBe(true);
    expect(validateServiceState(state).ok).toBe(false);
  });
});

describe('hunt detail', () => {
  it('accepts a full detail and refuses a bad evidence item', () => {
    const detail: HuntDetail = {
      ...sealed,
      model: 'claude-sonnet-5.5',
      toolCalls: 6,
      durationMs: 32_000,
      invalidCheck: null,
      stopDetail: null,
      linkedHuntId: null,
      creditsEstimated: false,
      allSteps: sealed.steps,
      evidence: [{ index: 1, kind: 'deploy', ref: 'deploy:d-7', detail: 'd-7 payments 65c0fca', cited: true }],
      fixHint: 'Restore the guard.',
      proposal: null,
    };
    expect(validateHuntDetail(detail).ok).toBe(true);
    expect(validateHuntDetail({ ...detail, stopDetail: 'fs_read' }).ok).toBe(true);
    expect(validateHuntDetail({ ...detail, stopDetail: 'x'.repeat(201) }).ok).toBe(false);
    expect(validateHuntDetail({ ...detail, stopDetail: '' }).ok).toBe(false);
    const without: Record<string, unknown> = { ...detail };
    delete without.stopDetail;
    expect(validateHuntDetail(without).ok).toBe(false);
    expect(validateHuntDetail({ ...detail, evidence: [{ ...detail.evidence[0], kind: 'shell' }] }).ok).toBe(false);
    expect(validateHuntDetail({ ...detail, model: 'Auto Model!' }).ok).toBe(false);
    expect(validateHuntDetail(null).ok).toBe(false);
  });
});

describe('hunt events', () => {
  it('are domain events with validators', () => {
    for (const name of HUNT_EVENT_NAMES) expect(DOMAIN_EVENT_NAMES).toContain(name);
    const finished = {
      huntId: ID,
      service: 'payments',
      status: 'failed',
      reason: 'invalid_diagnosis',
      invalidCheck: 'sha_unreachable',
      diagnosedBy: null,
      credits: 0.4,
      durationMs: 20_000,
      toolCalls: 5,
      finishedAt: '2026-11-13T10:41:31.000Z',
    };
    expect(validateSseEvent('hunt.finished', finished).ok).toBe(true);
    expect(validateHuntEvent('hunt.finished', { ...finished, status: 'succeeded' }).ok).toBe(false);
    expect(validateHuntEvent('hunt.finished', { ...finished, reason: 'timeout' }).ok).toBe(false);
    expect(validateHuntEvent('hunt.step', { huntId: ID, service: 'orders', index: 0, tool: 'diff_commit', summary: 'diff 65c0fca', at: finished.finishedAt }).ok).toBe(false);
    expect(validateHuntEvent('hunt.step', { huntId: ID, service: 'orders', index: 1, tool: 'fs_read', summary: 'x', at: finished.finishedAt }).ok).toBe(false);
    expect(
      validateHuntEvent('hunt.diagnosis', {
        huntId: ID,
        service: 'payments',
        culpritDeploy: 'd-7',
        culpritSha: SHA,
        culpritService: 'ledger',
        summary: 'guard removed',
        fixHint: '',
        cited: ['deploy:d-7', 'commit:' + SHA],
        at: finished.finishedAt,
      }).ok,
    ).toBe(true);
  });

  it('shortens a SHA to 7 characters', () => {
    expect(shortSha(SHA)).toBe('65c0fca');
  });
});
