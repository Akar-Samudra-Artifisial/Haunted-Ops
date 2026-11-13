import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isAdminAuthorized } from './admin-auth.guard.js';
import { parseKillSwitchBody, parseStartBody } from './hunts.controller.js';

const RUNS = { numRuns: 500 };
const token = fc.stringMatching(/^[A-Za-z0-9_-]{24,64}$/);

// Feature: exorcist-agent, Property 15
describe('Property 15: operator authentication is exact', () => {
  it('accepts the header `Bearer <token>` and nothing else', () => {
    fc.assert(
      fc.property(token, fc.oneof(fc.string({ maxLength: 80 }), fc.constant(undefined), fc.constant(null), fc.integer(), fc.array(fc.string())), (t, other) => {
        expect(isAdminAuthorized(`Bearer ${t}`, t)).toBe(true);
        expect(isAdminAuthorized(other, t)).toBe(other === `Bearer ${t}`);
      }),
      RUNS,
    );
  });

  it('refuses every near miss: another case, scheme, spacing, length or character', () => {
    fc.assert(
      fc.property(token, fc.integer({ min: 0, max: 63 }), fc.constantFrom('x', 'Z', '0', '-', ' '), (t, at, ch) => {
        const i = at % t.length;
        const changed = t.slice(0, i) + (t[i] === ch ? 'q' : ch) + t.slice(i + 1);
        const near = [
          `Bearer ${changed}`,
          `bearer ${t}`,
          `BEARER ${t}`,
          `Basic ${t}`,
          `Bearer  ${t}`,
          `Bearer ${t} `,
          ` Bearer ${t}`,
          `Bearer ${t}x`,
          `Bearer ${t.slice(0, -1)}`,
          `Bearer ${t.slice(1)}`,
          `Bearer\t${t}`,
          t,
          'Bearer ',
          'Bearer',
          '',
        ];
        for (const h of near) expect(isAdminAuthorized(h, t)).toBe(false);
      }),
      RUNS,
    );
  });

  it('refuses everything when no token is configured', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (h) => {
        expect(isAdminAuthorized(h, null)).toBe(false);
      }),
      RUNS,
    );
    expect(isAdminAuthorized('Bearer ', null)).toBe(false);
  });
});

describe('request bodies of the Hunt routes are strict', () => {
  const ID = 'cmincidentaaaaaaaaaaaaaaa';
  it('takes exactly one of incidentId or service', () => {
    expect(parseStartBody({ incidentId: ID })).toEqual({ trigger: 'operator', incidentId: ID });
    expect(parseStartBody({ service: 'payments' })).toEqual({ trigger: 'operator', service: 'payments' });
    for (const bad of [null, undefined, [], 'x', {}, { incidentId: ID, service: 'payments' }, { incidentId: ID, extra: 1 }, { incidentId: 'short' }, { incidentId: 7 }, { service: 'nope' }, { service: ['payments'] }, { trigger: 'auto', incidentId: ID }]) {
      expect(parseStartBody(bad)).toBeNull();
    }
  });

  it('takes only a boolean `enabled` for the kill switch', () => {
    expect(parseKillSwitchBody({ enabled: false })).toBe(false);
    expect(parseKillSwitchBody({ enabled: true })).toBe(true);
    for (const bad of [null, [], {}, { enabled: 'true' }, { enabled: 1 }, { enabled: true, x: 1 }, { Enabled: true }]) {
      expect(parseKillSwitchBody(bad)).toBeNull();
    }
  });
});
