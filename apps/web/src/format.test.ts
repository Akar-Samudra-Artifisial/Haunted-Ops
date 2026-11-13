import { describe, expect, it } from 'vitest';
import {
  NO_DATA,
  formatClock,
  formatErrorRatio,
  formatIncident,
  formatP95,
  formatReason,
  formatStaleNotice,
  formatUp,
} from './format.js';

describe('format', () => {
  it('formats the error ratio as a percentage', () => {
    expect(formatErrorRatio(0.22)).toBe('22%');
    expect(formatErrorRatio(0.05)).toBe('5%');
    expect(formatErrorRatio(0.0123)).toBe('1.2%');
    expect(formatErrorRatio(0)).toBe('0%');
    expect(formatErrorRatio(1)).toBe('100%');
    expect(formatErrorRatio(null)).toBe(NO_DATA);
  });

  it('formats the p95 in ms below 1000 and in s from 1000', () => {
    expect(formatP95(640)).toBe('640 ms');
    expect(formatP95(999.4)).toBe('999 ms');
    expect(formatP95(1000)).toBe('1.0 s');
    expect(formatP95(2200)).toBe('2.2 s');
    expect(formatP95(null)).toBe(NO_DATA);
  });

  it('formats up and down', () => {
    expect(formatUp(1)).toBe('up');
    expect(formatUp(0.5)).toBe('up');
    expect(formatUp(0.49)).toBe('down');
    expect(formatUp(0)).toBe('down');
    expect(formatUp(null)).toBe(NO_DATA);
  });

  it('formats the reason', () => {
    expect(formatReason({ kind: 'error_rate', value: 0.22 })).toBe('error rate 22%');
    expect(formatReason({ kind: 'p95', value: 2200 })).toBe('p95 2.2 s');
    expect(formatReason({ kind: 'p95', value: 640 })).toBe('p95 640 ms');
    expect(formatReason({ kind: 'down', value: 0 })).toBe('service down');
    expect(formatReason(null)).toBe('none');
  });

  it('shows the live metric value for the reason kind, and the stored value when there is none', () => {
    const live = { errorRate: 0.4, p95Ms: 3100, up: 1, at: '2026-11-13T14:00:00.000Z' };
    expect(formatReason({ kind: 'error_rate', value: 0.22 }, live)).toBe('error rate 40%');
    expect(formatReason({ kind: 'p95', value: 2200 }, live)).toBe('p95 3.1 s');
    expect(formatReason({ kind: 'error_rate', value: 0.22 }, { ...live, errorRate: null })).toBe('error rate 22%');
    expect(formatReason({ kind: 'p95', value: 2200 }, null)).toBe('p95 2.2 s');
    expect(formatReason({ kind: 'down', value: 0 }, live)).toBe('service down');
    expect(formatReason(null, live)).toBe('none');
  });

  it('formats incidents, clocks and the stale notice', () => {
    expect(formatIncident(null)).toBe('none');
    expect(formatIncident({ id: 'i', openedAt: '2026-11-13T14:02:10.000Z', peakLevel: 3 })).toBe(
      'opened 14:02:10 UTC, peak 3 (possessed)',
    );
    expect(formatClock('2026-11-13T14:02:10.000Z')).toBe('14:02:10 UTC');
    expect(formatStaleNotice({ state: 'stale', at: 'x', lastSuccessAt: '2026-11-13T14:02:10.000Z' })).toBe(
      'Metrics are stale. Last update 14:02:10 UTC.',
    );
    expect(formatStaleNotice({ state: 'stale', at: 'x', lastSuccessAt: null })).toBe(
      'Metrics are stale. No update received yet.',
    );
  });
});
