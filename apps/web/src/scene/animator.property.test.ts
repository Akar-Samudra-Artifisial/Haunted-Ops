// Feature: scene-engine, Property 10: the animator keeps its pools, stays within caps and rests when still
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SERVICE_NAMES, type ServiceState } from '@haunted-ops/shared';
import { ROOMS, serviceStateArb } from '../test/arbs.js';
import { FULL, REDUCED, scene } from '../test/scene-fakes.js';
import { createAnimator } from './animator.js';
import type { ModelOptions } from './model.js';
import { PARTICLE_CAP } from './particles.js';
import type { Frame } from './surface.js';

const RUNS = { numRuns: 80 };

/** A house of 1 to 4 distinct services in their standard rooms, each in a random state. */
const houseArb: fc.Arbitrary<ServiceState[]> = fc
  .tuple(fc.subarray([...SERVICE_NAMES], { minLength: 1 }), fc.array(serviceStateArb, { minLength: 4, maxLength: 4 }))
  .map(([names, states]) => names.map((name, i) => ({ ...states[i]!, name, room: ROOMS[name] })));

const optionsArb: fc.Arbitrary<ModelOptions> = fc.record({
  reducedMotion: fc.boolean(),
  quality: fc.constantFrom('full' as const, 'low' as const),
});
const viewportArb = fc.record({ width: fc.integer({ min: 360, max: 3840 }), height: fc.integer({ min: 360, max: 2160 }), dpr: fc.constantFrom(1, 2) });

type Op =
  | { op: 'model'; services: ServiceState[]; options: ModelOptions }
  | { op: 'layout'; viewport: { width: number; height: number; dpr: number } }
  | { op: 'select'; name: (typeof SERVICE_NAMES)[number] | null }
  | { op: 'step'; dt: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ op: fc.constant('model' as const), services: houseArb, options: optionsArb }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('layout' as const), viewport: viewportArb }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('select' as const), name: fc.option(fc.constantFrom(...SERVICE_NAMES), { nil: null }) }) },
  { weight: 6, arbitrary: fc.record({ op: fc.constant('step' as const), dt: fc.integer({ min: 0, max: 400 }) }) },
);

describe('Property 10: the animator keeps its pools, stays within caps and rests when still', () => {
  it('returns the same Frame and arrays, and counts within capacity and the cap, for any sequence', () => {
    fc.assert(
      fc.property(houseArb, optionsArb, viewportArb, fc.array(opArb, { maxLength: 40 }), (services, options, viewport, ops) => {
        const a = createAnimator();
        const first = scene(services, options, viewport);
        a.setLayout(first.layout);
        a.setModel(first.model);
        let current = services;
        let currentOptions = options;
        let layout = first.layout;
        const frame0 = a.step(16, 16);
        const arrays = [frame0.ghosts.x, frame0.ghosts.alpha, frame0.fog.x, frame0.motes.y, frame0.pulses.size];
        let time = 16;
        for (const o of ops) {
          if (o.op === 'model') {
            const s = scene(o.services, o.options, { width: layout.width, height: layout.height, dpr: layout.dpr });
            // The layout follows the rooms in the model.
            current = o.services;
            currentOptions = o.options;
            layout = s.layout;
            a.setLayout(layout);
            a.setModel(s.model);
          } else if (o.op === 'layout') {
            layout = scene(current, currentOptions, o.viewport).layout;
            a.setLayout(layout);
          } else if (o.op === 'select') {
            a.select(o.name);
          } else {
            time += o.dt;
            const f = a.step(o.dt, time);
            expect(f).toBe(frame0);
            expect([f.ghosts.x, f.ghosts.alpha, f.fog.x, f.motes.y, f.pulses.size]).toEqual(arrays);
            for (const buf of [f.ghosts, f.fog, f.motes, f.pulses]) {
              expect(buf.count).toBeGreaterThanOrEqual(0);
              expect(buf.count).toBeLessThanOrEqual(buf.capacity);
              for (let i = 0; i < buf.count; i++) {
                expect(Number.isFinite(buf.x[i]!) && Number.isFinite(buf.y[i]!) && Number.isFinite(buf.size[i]!)).toBe(true);
                expect(buf.alpha[i]!).toBeGreaterThan(0);
                expect(buf.alpha[i]!).toBeLessThanOrEqual(1.0001);
              }
            }
            expect(f.ghosts.count + f.fog.count + f.motes.count + f.pulses.count).toBeLessThanOrEqual(PARTICLE_CAP);
          }
        }
      }),
      RUNS,
    );
  });

  it('with reduced motion the wisps stand still, and the frame reports it can rest', () => {
    fc.assert(
      fc.property(houseArb, viewportArb, fc.integer({ min: 1000, max: 600_000 }), (services, viewport, later) => {
        const a = createAnimator();
        const s = scene(services, REDUCED, viewport);
        a.setLayout(s.layout);
        a.setModel(s.model);
        let t = 0;
        let f!: Frame;
        for (let i = 0; i < 8; i++) {
          t += 100;
          f = a.step(100, t);
        }
        expect(f.moving).toBe(false);
        const snapshot = (): number[] =>
          [f.ghosts, f.fog, f.motes].flatMap((b) => [b.count, ...Array.from(b.x.slice(0, b.count)), ...Array.from(b.y.slice(0, b.count))]);
        const before = snapshot();
        f = a.step(16, t + later);
        expect(snapshot()).toEqual(before);
        expect(f.moving).toBe(false);
        expect(f.rooms.every((r) => r.flicker === 1 && r.shakeX === 0 && r.shakeY === 0)).toBe(true);
      }),
      RUNS,
    );
  });

  it('without reduced motion the animator keeps asking for frames', () => {
    fc.assert(
      fc.property(houseArb, (services) => {
        const a = createAnimator();
        const s = scene(services, FULL);
        a.setLayout(s.layout);
        a.setModel(s.model);
        let f!: Frame;
        for (let i = 0; i < 60; i++) f = a.step(100, (i + 1) * 100);
        expect(f.moving).toBe(true);
      }),
      RUNS,
    );
  });
});
