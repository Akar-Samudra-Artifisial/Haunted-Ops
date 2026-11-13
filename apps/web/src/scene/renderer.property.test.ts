// Feature: scene-engine, Property 11: the renderer cleans up after itself
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FULL, REDUCED, FakeEnv, FakeSurface, ManualLoop, house, scene } from '../test/scene-fakes.js';
import { createSceneRenderer } from './renderer.js';

type Op = 'start' | 'update' | 'resize' | 'select' | 'hide' | 'show' | 'lost' | 'restored' | 'destroy' | 'step' | 'release';
const OPS: Op[] = ['start', 'update', 'resize', 'select', 'hide', 'show', 'lost', 'restored', 'destroy', 'step', 'release'];

describe('Property 11: the renderer cleans up after itself', () => {
  it('releases everything after destroy, never draws when dead, never makes a second surface', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom(...OPS), { maxLength: 40 }), fc.boolean(), fc.boolean(), async (ops, gated, reduced) => {
        const surface = new FakeSurface();
        const loop = new ManualLoop();
        const env = new FakeEnv();
        const renderer = createSceneRenderer({ surface, loop, env });
        const options = reduced ? REDUCED : FULL;
        const first = scene(house(), options);
        const second = scene(house({ payments: { hauntLevel: 3 } }), options, { width: 700, height: 500, dpr: 2 });
        let open: () => void = () => undefined;
        if (gated) {
          surface.gate = new Promise<void>((r) => {
            open = r;
          });
        }
        let starting: Promise<void> = Promise.resolve();
        let destroyed = false;
        let drawsAtDestroy = -1;
        for (const op of ops) {
          switch (op) {
            case 'start':
              starting = renderer.start({ host: document.createElement('div'), ...first }).catch(() => undefined);
              break;
            case 'update':
              renderer.update(second.model);
              break;
            case 'resize':
              renderer.resize(second.layout);
              break;
            case 'select':
              renderer.select('payments');
              break;
            case 'hide':
              env.setHidden(true);
              expect(loop.running).toBe(false);
              break;
            case 'show':
              env.setHidden(false);
              break;
            case 'lost':
              surface.emit('lost');
              break;
            case 'restored':
              surface.emit('restored');
              break;
            case 'destroy':
              renderer.destroy();
              if (!destroyed) drawsAtDestroy = surface.draws;
              destroyed = true;
              expect(loop.running).toBe(false);
              break;
            case 'release':
              open();
              break;
            case 'step': {
              const before = surface.lastFrame?.time ?? 0;
              if (loop.step(env.hidden ? 5000 : 16)) {
                expect(env.hidden).toBe(false);
                expect(destroyed).toBe(false);
                // A step never jumps in time by more than 100 ms.
                expect((surface.lastFrame?.time ?? 0) - before).toBeLessThanOrEqual(100 + 1e-9);
              }
              break;
            }
          }
          expect(surface.initCount).toBeLessThanOrEqual(1);
          expect(surface.drawsWhileDead).toBe(0);
        }
        open();
        await starting;
        await Promise.resolve();
        expect(surface.initCount).toBeLessThanOrEqual(1);
        expect(surface.drawsWhileDead).toBe(0);
        if (destroyed) {
          expect(loop.running).toBe(false);
          expect(env.listenerCount).toBe(0);
          expect(surface.alive).toBe(false);
          expect(surface.draws).toBe(drawsAtDestroy);
          renderer.destroy();
          expect(surface.alive).toBe(false);
        }
      }),
      { numRuns: 150 },
    );
  });
});
