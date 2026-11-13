import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SERVICE_DEPENDENCIES, SERVICE_NAMES, downstreamOf, isCulpritCandidate, mostDownstream, type ServiceName } from '../src/index.js';

const nameArb = fc.constantFrom(...SERVICE_NAMES);
const setArb = fc.uniqueArray(nameArb, { maxLength: 4 });

describe('service dependencies', () => {
  it('is the call chain gate, orders, payments, ledger', () => {
    expect(SERVICE_DEPENDENCIES).toEqual({ gate: ['orders'], orders: ['payments'], payments: ['ledger'], ledger: [] });
    expect(downstreamOf('gate')).toEqual(['orders', 'payments', 'ledger']);
    expect(downstreamOf('orders')).toEqual(['payments', 'ledger']);
    expect(downstreamOf('payments')).toEqual(['ledger']);
    expect(downstreamOf('ledger')).toEqual([]);
  });

  it('never lists a service as its own downstream, and has no cycle', () => {
    for (const s of SERVICE_NAMES) {
      expect(downstreamOf(s)).not.toContain(s);
      for (const d of downstreamOf(s)) expect(downstreamOf(d)).not.toContain(s);
    }
  });
});

// Feature: exorcist-agent, Property 17
describe('Property 17: only the most downstream service of a set is hunted', () => {
  it('picks a member with nothing downstream of it in the set, and every other member depends on it', () => {
    fc.assert(
      fc.property(setArb, fc.constantFrom(0, 1, 2, 3), (set, rotate) => {
        // The answer does not depend on the order the members arrive in.
        const shuffled = [...set.slice(rotate % Math.max(1, set.length)), ...set.slice(0, rotate % Math.max(1, set.length))];
        const picked = mostDownstream(shuffled);
        expect(mostDownstream(set)).toBe(picked);
        if (set.length === 0) {
          expect(picked).toBeNull();
          return;
        }
        expect(set).toContain(picked);
        for (const other of set) {
          if (other === picked) continue;
          expect(downstreamOf(other)).toContain(picked as ServiceName);
          expect(downstreamOf(picked as ServiceName)).not.toContain(other);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('names ledger for a full cascade and the lone service otherwise', () => {
    expect(mostDownstream(['gate', 'orders', 'payments', 'ledger'])).toBe('ledger');
    expect(mostDownstream(['gate', 'orders'])).toBe('orders');
    expect(mostDownstream(['gate', 'payments'])).toBe('payments');
    for (const s of SERVICE_NAMES) expect(mostDownstream([s])).toBe(s);
  });
});

// Feature: exorcist-agent, Property 18
describe('Property 18: a culprit is a candidate iff its service is the hunted one or downstream of it', () => {
  it('matches the definition for every pair', () => {
    fc.assert(
      fc.property(nameArb, nameArb, (hunted, culprit) => {
        expect(isCulpritCandidate(hunted, culprit)).toBe(hunted === culprit || downstreamOf(hunted).includes(culprit));
      }),
    );
    expect(isCulpritCandidate('gate', 'orders')).toBe(true);
    expect(isCulpritCandidate('orders', 'gate')).toBe(false);
    expect(isCulpritCandidate('payments', 'orders')).toBe(false);
    expect(isCulpritCandidate('ledger', 'ledger')).toBe(true);
    expect(isCulpritCandidate('ledger', 'payments')).toBe(false);
  });
});
