import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPOSAL_STATUSES } from '@haunted-ops/shared';
import { MARKS, hauntMark, statusMark, type MarkGroup } from './status-marks.js';

describe('status marks', () => {
  it('covers the five levels, dark, the connection, deploy and every proposal status', () => {
    expect(hauntMark(4)).toEqual({ label: 'dark', symbol: '●' });
    expect(hauntMark(0).label).toBe('calm');
    expect(statusMark('haunt', 'room-dark').label).toBe('room dark');
    expect(Object.keys(MARKS.connection)).toEqual(['live', 'reconnecting', 'offline', 'demo']);
    expect(Object.keys(MARKS.proposal).sort()).toEqual([...PROPOSAL_STATUSES].sort());
  });
});

describe('Property 6: statuses have distinct marks', () => {
  // Feature: accessible-mode, Property 6
  it('gives two statuses of one group different symbols, each with a label', () => {
    const groups = Object.keys(MARKS) as MarkGroup[];
    fc.assert(
      fc.property(fc.constantFrom(...groups), fc.nat(), fc.nat(), (group, i, j) => {
        const keys = Object.keys(MARKS[group]);
        const a = keys[i % keys.length] as string;
        const b = keys[j % keys.length] as string;
        const ma = (MARKS[group] as Record<string, { label: string; symbol: string }>)[a]!;
        const mb = (MARKS[group] as Record<string, { label: string; symbol: string }>)[b]!;
        expect(ma.label.length).toBeGreaterThan(0);
        expect(ma.symbol.length).toBeGreaterThan(0);
        if (a !== b) expect(ma.symbol).not.toBe(mb.symbol);
      }),
      { numRuns: 200 },
    );
  }, 30_000);
});
