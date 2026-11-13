import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SERVICE_NAMES } from '@haunted-ops/shared';
import { makeService } from '../test/arbs.js';
import { approach, clamp } from './math.js';
import { CONTRAST_PAIRS, PALETTE, hexToNumber } from './palette.js';
import {
  FOG_MAX,
  GHOST_MAX,
  MOTE_MAX,
  PARTICLE_CAP,
  allocateParticles,
  fogSpec,
  ghostSpec,
  moteSpec,
  type RoomCounts,
} from './particles.js';
import { hashString, mulberry32, unit } from './rng.js';
import { isDark, levelLabel, toSceneModel, type ModelOptions } from './model.js';

const NOW = Date.parse('2026-11-13T15:30:00.000Z');
const FULL: ModelOptions = { reducedMotion: false, quality: 'full' };
const room = (s: Parameters<typeof makeService>[1], name: Parameters<typeof makeService>[0] = 'payments', opts = FULL) =>
  toSceneModel([makeService(name, s)], NOW, opts).rooms[0]!;

function luminance(hex: string): number {
  const n = hexToNumber(hex);
  const f = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
}
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe('palette', () => {
  it('repeats the CSS custom properties it shares with styles.css', () => {
    // Vitest runs with apps/web as the working directory.
    const css = readFileSync('src/styles.css', 'utf8');
    expect(css).toContain(`--bg: ${PALETTE.night}`);
    expect(css).toContain(`--focus: ${PALETTE.ring}`);
  });

  it('passes the contrast limits for every pair that carries text or a shape', () => {
    for (const pair of CONTRAST_PAIRS) {
      const ratio = contrast(PALETTE[pair.fg], PALETTE[pair.bg]);
      expect(ratio, pair.name).toBeGreaterThanOrEqual(pair.kind === 'text' ? 4.5 : 3);
    }
  });

  it('converts hex to the number PixiJS takes', () => {
    expect(hexToNumber('#14121c')).toBe(0x14121c);
  });
});

describe('math and seeds', () => {
  it('clamps', () => {
    expect([clamp(-1, 0, 1), clamp(0.5, 0, 1), clamp(3, 0, 1)]).toEqual([0, 0.5, 1]);
  });

  it('approaches without passing the target, and reaches 95 percent in one second with tau of a third', () => {
    expect(approach(0, 1, 0, 333)).toBe(0);
    expect(approach(0, 1, 1000, 0)).toBe(1);
    expect(approach(0, 1, 1000, 1000 / 3)).toBeGreaterThan(0.94);
    expect(approach(0, 1, 1000, 1000 / 3)).toBeLessThan(1);
    expect(approach(1, 0, 1e9, 10)).toBe(0);
  });

  it('gives the same seeded numbers every time', () => {
    expect(hashString('payments')).toBe(hashString('payments'));
    expect(hashString('payments')).not.toBe(hashString('orders'));
    const a = mulberry32(7);
    const b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(unit(1, 2, 3)).toBe(unit(1, 2, 3));
    expect(unit(1, 2, 3)).not.toBe(unit(1, 3, 3));
    for (let i = 0; i < 100; i++) expect(unit(99, i, 1)).toBeGreaterThanOrEqual(0);
  });
});

describe('particle specs and allocation', () => {
  it('keeps every wisp and its path inside the floor', () => {
    for (const spec of [ghostSpec, fogSpec, moteSpec]) {
      for (let i = 0; i < 40; i++) {
        const w = spec(12345, i);
        expect(w.u - w.ampU).toBeGreaterThanOrEqual(0.05);
        expect(w.u + w.ampU).toBeLessThanOrEqual(0.95);
        expect(w.v - w.ampV).toBeGreaterThanOrEqual(0.05);
        expect(w.v + w.ampV).toBeLessThanOrEqual(0.95);
      }
    }
  });

  it('trims motes first, then fog, then ghosts, from the lowest level up', () => {
    const wanted: RoomCounts[] = [
      { level: 3, ghosts: 12, fog: 14, motes: 0 },
      { level: 0, ghosts: 0, fog: 0, motes: 6 },
      { level: 2, ghosts: 12, fog: 14, motes: 0 },
    ];
    // Total 58, budget 40: motes (6) go first, then 12 from the fog of the lowest-level room with fog.
    const out = allocateParticles(wanted, 40);
    expect(out[1]).toMatchObject({ motes: 0 });
    expect(out[2]).toMatchObject({ fog: 14 - 12 });
    expect(out[0]).toMatchObject({ fog: 14, ghosts: 12 });
    expect(allocateParticles(wanted, 1000)).toEqual(wanted);
  });
});

describe('toSceneModel', () => {
  it('is calm and warm at level 0 with motes and a clock', () => {
    const r = room({});
    expect(r).toMatchObject({ level: 0, levelLabel: 'calm', dark: false, light: 1, ghostCount: 0, fogCount: 0, moteCount: MOTE_MAX, badge: '', badgeShort: '' });
    expect(r.clock.minute).toBeCloseTo((30 / 60) * Math.PI * 2);
    expect(r.clock.hour).toBeCloseTo(((3 + 0.5) / 12) * Math.PI * 2);
    expect(r.seed).toBe(hashString('payments'));
    expect('hunt' in r).toBe(false);
  });

  it('scales ghosts with the error ratio, from 0 at 0 to the cap at 0.5', () => {
    const at = (errorRate: number) => room({ hauntLevel: 2, metrics: { errorRate, p95Ms: null, up: 1, at: 'x' } });
    expect(at(0).ghostCount).toBe(0);
    expect(at(0).ghostOpacity).toBe(0);
    expect(at(0.25).ghostCount).toBe(GHOST_MAX / 2);
    expect(at(0.25).ghostOpacity).toBeCloseTo(0.25 + 0.6 * 0.5);
    expect(at(0.5).ghostCount).toBe(GHOST_MAX);
    expect(at(1).ghostCount).toBe(GHOST_MAX);
    expect(at(1).ghostOpacity).toBeCloseTo(0.85);
  });

  it('scales fog with the p95, from 0 at 200 ms to full at 3000 ms', () => {
    const at = (p95Ms: number) => room({ hauntLevel: 2, metrics: { errorRate: 0, p95Ms, up: 1, at: 'x' } }, 'orders');
    expect(at(200).fogDensity).toBe(0);
    expect(at(1600).fogDensity).toBeCloseTo(0.5);
    expect(at(1600).fogCount).toBe(FOG_MAX / 2);
    expect(at(3000).fogDensity).toBe(1);
    expect(at(9000).fogCount).toBe(FOG_MAX);
  });

  it('draws no ghost for the background error ratio of a calm service', () => {
    const calm = room({ hauntLevel: 0, metrics: { errorRate: 0.004, p95Ms: 70, up: 1, at: 'x' } });
    expect(calm.ghostCount).toBe(0);
    expect(calm.ghostOpacity).toBe(0);
    expect(room({ hauntLevel: 0, metrics: { errorRate: 0.02, p95Ms: 70, up: 1, at: 'x' } }).ghostCount).toBe(0);
    expect(room({ hauntLevel: 1, metrics: { errorRate: 0.06, p95Ms: 70, up: 1, at: 'x' } }).ghostCount).toBe(1);
  });

  it('falls back to the reason value when the metric is null, and shows at least one wisp for an error reason', () => {
    const r = room({ hauntLevel: 2, reason: { kind: 'error_rate', value: 0.25 }, metrics: { errorRate: null, p95Ms: null, up: 1, at: 'x' } });
    expect(r.ghostCount).toBe(GHOST_MAX / 2);
    const faint = room({ hauntLevel: 1, reason: { kind: 'error_rate', value: 0.001 }, metrics: null });
    expect(faint.ghostCount).toBe(1);
    const fog = room({ hauntLevel: 2, reason: { kind: 'p95', value: 2200 }, metrics: null }, 'orders');
    expect(fog.fogDensity).toBeCloseTo((2200 - 200) / 2800);
  });

  it('makes slowness fog thick from level 2 even when the p95 is just over the threshold', () => {
    const slow = (hauntLevel: 1 | 2 | 3) => room({ hauntLevel, reason: { kind: 'p95', value: 1100 }, metrics: { errorRate: 0, p95Ms: 1100, up: 1, at: 'x' } }, 'orders');
    expect(slow(1).fogDensity).toBeCloseTo(0.32);
    expect(slow(2).fogDensity).toBeCloseTo(0.6);
    expect(slow(3).fogDensity).toBeCloseTo(0.9);
    expect(slow(2).fogCount).toBe(Math.ceil(0.6 * FOG_MAX));
  });

  it('dims the light by level and by the metrics', () => {
    expect([0, 1, 2, 3].map((hauntLevel) => room({ hauntLevel: hauntLevel as 0 }).light)).toEqual([1, 0.85, 0.65, 0.5]);
    const m = room({ hauntLevel: 2, metrics: { errorRate: 0.5, p95Ms: 3000, up: 1, at: 'x' } });
    expect(m.light).toBeCloseTo(0.65 * 0.8 * 0.7);
  });

  it('is dark at level 4 and when up is below 0.5, and only then', () => {
    expect(isDark(makeService('ledger', { hauntLevel: 4 }))).toBe(true);
    const down = makeService('ledger', { hauntLevel: 2, metrics: { errorRate: null, p95Ms: null, up: 0, at: 'x' } });
    expect(isDark(down)).toBe(true);
    const edge = (up: number | null) => isDark(makeService('ledger', { hauntLevel: 2, metrics: { errorRate: 0, p95Ms: 0, up, at: 'x' } }));
    expect([edge(0.5), edge(0.4999), edge(null), edge(1)]).toEqual([false, true, false, false]);
    const r = room({ hauntLevel: 4, reason: { kind: 'down', value: 0 } }, 'ledger');
    expect(r).toMatchObject({ dark: true, light: 0, moteCount: 0, badge: 'service down', badgeShort: 'DOWN' });
  });

  it('sets the motion amplitudes by level and removes them with reduced motion', () => {
    const at = (hauntLevel: 0 | 1 | 2 | 3 | 4, reducedMotion = false) => room({ hauntLevel }, 'payments', { reducedMotion, quality: 'full' });
    expect(at(3).motion).toMatchObject({ flicker: 0.3, tremble: 0.012 });
    expect(at(2).motion.flicker).toBe(0.05);
    expect(at(0).motion.flicker).toBe(0);
    expect(at(3, true).motion).toEqual({ drift: 0, flicker: 0, tremble: 0 });
    expect(toSceneModel([], NOW, { reducedMotion: true, quality: 'full' }).transitionMs).toBe(0);
    expect(toSceneModel([], NOW, FULL).transitionMs).toBe(1000);
  });

  it('halves the counts in low quality', () => {
    const s = makeService('payments', { hauntLevel: 2, metrics: { errorRate: 0.5, p95Ms: 3000, up: 1, at: 'x' } });
    const low = toSceneModel([s], NOW, { reducedMotion: false, quality: 'low' }).rooms[0]!;
    expect([low.ghostCount, low.fogCount]).toEqual([GHOST_MAX / 2, FOG_MAX / 2]);
  });

  it('writes the badge, the short badge, the incident mark and the summary', () => {
    const s = makeService('payments', {
      hauntLevel: 2,
      reason: { kind: 'error_rate', value: 0.22 },
      metrics: { errorRate: 0.22, p95Ms: 100, up: 1, at: 'x' },
      openIncident: { id: 'i', openedAt: 'x', peakLevel: 3 },
    });
    const model = toSceneModel([s], NOW, FULL);
    const r = model.rooms[0]!;
    expect(r).toMatchObject({ badge: 'error rate 22%', badgeShort: 'ERR 22%', badgeKind: 'error_rate', incident: { open: true, peakLevel: 3 } });
    expect(r.summary).toBe('payments: haunted, error rate 22%, incident open');
    expect(model.summary).toBe(r.summary);
    const p = room({ hauntLevel: 2, reason: { kind: 'p95', value: 2200 } }, 'orders');
    expect([p.badge, p.badgeShort]).toEqual(['p95 2.2 s', 'P95 2.2 s']);
  });

  it('says "dark" in the summary for a dark room at a lower level', () => {
    const r = room({ hauntLevel: 2, metrics: { errorRate: null, p95Ms: null, up: 0, at: 'x' } }, 'ledger');
    expect(r.summary).toBe('ledger: haunted, dark');
    expect(levelLabel(4)).toBe('dark');
  });

  it('handles an empty array and keeps the input order', () => {
    const empty = toSceneModel([], NOW, FULL);
    expect(empty.rooms).toEqual([]);
    expect(empty.summary).toBe('No rooms yet');
    const model = toSceneModel(SERVICE_NAMES.map((n) => makeService(n)).reverse(), NOW, FULL);
    expect(model.rooms.map((r) => r.name)).toEqual([...SERVICE_NAMES].reverse());
  });

  it('counts the particles of the 2 by 2 house with the corridor pulses and trims nothing', () => {
    const calm = toSceneModel(SERVICE_NAMES.map((n) => makeService(n)), NOW, FULL);
    expect(calm.particles).toEqual({ wanted: 4 * MOTE_MAX + 9, total: 4 * MOTE_MAX + 9, cap: PARTICLE_CAP, trimmed: false });
  });

  it('trims a house of nine rooms to the cap', () => {
    const nine = Array.from({ length: 9 }, (_, i) =>
      makeService('payments', {
        room: { x: i % 3, y: Math.floor(i / 3) },
        hauntLevel: 2,
        metrics: { errorRate: 0.5, p95Ms: 3000, up: 1, at: 'x' },
      }),
    );
    const model = toSceneModel(nine, NOW, FULL);
    expect(model.particles.total).toBeLessThanOrEqual(PARTICLE_CAP);
    expect(model.particles.trimmed).toBe(true);
  });
});
