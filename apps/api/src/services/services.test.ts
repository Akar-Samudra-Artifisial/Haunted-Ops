import { validateServiceStates } from '@haunted-ops/shared';
import { describe, expect, it } from 'vitest';
import { withinTimeout } from '../health/health.controller.js';
import { toServiceStates } from './services.service.js';

const at = new Date('2026-11-12T10:00:00.000Z');

describe('toServiceStates', () => {
  it('returns valid Service state in room order and drops unknown names', () => {
    const rows = [
      { name: 'ledger', roomX: 1, roomY: 1, hauntLevel: 0, updatedAt: at },
      { name: 'cellar', roomX: 9, roomY: 9, hauntLevel: 0, updatedAt: at },
      { name: 'gate', roomX: 0, roomY: 0, hauntLevel: 2, updatedAt: at },
      { name: 'payments', roomX: 0, roomY: 1, hauntLevel: 4, updatedAt: at },
    ];
    const states = toServiceStates(rows);
    expect(states.map((s) => s.name)).toEqual(['gate', 'payments', 'ledger']);
    expect(validateServiceStates(states).ok).toBe(true);
    expect(states[0]).toEqual({ name: 'gate', room: { x: 0, y: 0 }, hauntLevel: 2, updatedAt: '2026-11-12T10:00:00.000Z' });
  });

  it('refuses an out-of-range haunt level', () => {
    expect(() => toServiceStates([{ name: 'gate', roomX: 0, roomY: 0, hauntLevel: 7, updatedAt: at }])).toThrow();
  });
});

describe('withinTimeout', () => {
  it('is true only when the check resolves in time', async () => {
    expect(await withinTimeout(async () => 1, 50)).toBe(true);
    expect(await withinTimeout(async () => Promise.reject(new Error('x')), 50)).toBe(false);
    expect(await withinTimeout(() => new Promise(() => undefined), 20)).toBe(false);
  });
});
