import { describe, expect, it, vi } from 'vitest';
import { FULL, REDUCED, FakeEnv, FakeSurface, ManualLoop, house, scene } from '../test/scene-fakes.js';
import type { PerfGovernor } from './governor.js';
import { createSceneRenderer } from './renderer.js';
import { SceneInitError } from './surface.js';

function setup(opts: { reduced?: boolean; governor?: PerfGovernor } = {}) {
  const surface = new FakeSurface();
  const loop = new ManualLoop();
  const env = new FakeEnv();
  const onQuality = vi.fn();
  const onContext = vi.fn();
  const renderer = createSceneRenderer({ surface, loop, env, governor: opts.governor, onQuality, onContext });
  const s = scene(house(), opts.reduced ? REDUCED : FULL);
  const host = document.createElement('div');
  return { surface, loop, env, renderer, onQuality, onContext, s, host, start: () => renderer.start({ host, ...s }) };
}

describe('createSceneRenderer', () => {
  it('starts the surface, applies layout then model, draws, and runs the loop while things move', async () => {
    const t = setup();
    await t.start();
    expect(t.surface.calls).toEqual(['init', 'applyLayout', 'applyModel']);
    expect(t.loop.running).toBe(true);
    t.loop.step();
    expect(t.surface.draws).toBe(1);
    expect(t.renderer.stats.frames).toBe(1);
    expect(t.renderer.stats.particles).toBeGreaterThan(0);
  });

  it('stops the loop when nothing moves (reduced motion) and starts it again on a change', async () => {
    const t = setup({ reduced: true });
    await t.start();
    t.loop.step();
    t.loop.step();
    expect(t.loop.running).toBe(false);
    const draws = t.surface.draws;
    expect(t.loop.step()).toBe(false);
    expect(t.surface.draws).toBe(draws);
    t.renderer.select('payments');
    expect(t.loop.running).toBe(true);
    t.loop.step();
    expect(t.surface.lastFrame?.selected).toBe('payments');
    t.renderer.update(scene(house({ ledger: { hauntLevel: 4 } }), REDUCED).model);
    expect(t.loop.running).toBe(true);
    expect(t.surface.calls.filter((c) => c === 'applyModel')).toHaveLength(2);
  });

  it('does not create a second surface on update or resize', async () => {
    const t = setup();
    await t.start();
    t.renderer.update(scene(house({ payments: { hauntLevel: 2 } })).model);
    t.renderer.resize(scene(house(), FULL, { width: 600, height: 400, dpr: 2 }).layout);
    expect(t.surface.initCount).toBe(1);
    expect(t.surface.calls).toContain('resize');
  });

  it('pauses while the tab is hidden and resumes with a first step of at most 100 ms', async () => {
    const t = setup();
    await t.start();
    t.loop.step(16);
    t.env.setHidden(true);
    expect(t.loop.running).toBe(false);
    t.renderer.update(scene(house({ payments: { hauntLevel: 2 } })).model);
    expect(t.loop.running).toBe(false);
    t.env.setHidden(false);
    expect(t.loop.running).toBe(true);
    const before = t.surface.draws;
    t.loop.step(60_000);
    expect(t.surface.draws).toBe(before + 1);
    expect(t.surface.lastFrame!.time).toBeLessThanOrEqual(16 + 100 + 1);
  });

  it('does not start the loop when the tab is hidden at start', async () => {
    const t = setup();
    t.env.hidden = true;
    await t.start();
    expect(t.loop.running).toBe(false);
    t.env.setHidden(false);
    expect(t.loop.running).toBe(true);
  });

  it('switches to low power when the governor says so and tells the app', async () => {
    const t = setup();
    await t.start();
    for (let i = 0; i < 100 && t.loop.running; i++) t.loop.step(30);
    expect(t.surface.quality).toBe('low');
    expect(t.onQuality).toHaveBeenCalledWith('low');
    expect(t.renderer.stats.quality).toBe('low');
  });

  it('stops on context loss, reports it, and resumes when the context is restored', async () => {
    const t = setup();
    await t.start();
    t.surface.emit('lost');
    expect(t.loop.running).toBe(false);
    expect(t.onContext).toHaveBeenCalledWith('lost');
    t.surface.emit('restored');
    expect(t.onContext).toHaveBeenCalledWith('restored');
    expect(t.loop.running).toBe(true);
  });

  it('cleans up on destroy: loop stopped, subscription removed, surface released, no draw afterwards', async () => {
    const t = setup();
    await t.start();
    t.loop.step();
    expect(t.env.listenerCount).toBe(1);
    t.renderer.destroy();
    expect(t.loop.running).toBe(false);
    expect(t.env.listenerCount).toBe(0);
    expect(t.surface.alive).toBe(false);
    t.renderer.destroy();
    expect(t.surface.destroyCount).toBe(1);
    t.renderer.update(t.s.model);
    t.renderer.select('gate');
    t.env.setHidden(false);
    expect(t.loop.running).toBe(false);
    expect(t.surface.drawsWhileDead).toBe(0);
  });

  it('releases the surface when destroyed before the setup has finished', async () => {
    const t = setup();
    let open!: () => void;
    t.surface.gate = new Promise<void>((r) => {
      open = r;
    });
    const starting = t.start();
    t.renderer.destroy();
    open();
    await starting;
    expect(t.surface.alive).toBe(false);
    expect(t.loop.running).toBe(false);
    expect(t.env.listenerCount).toBe(0);
    expect(t.surface.draws).toBe(0);
  });

  it('destroys the surface and rethrows when the setup fails', async () => {
    const t = setup();
    t.surface.failInit = new SceneInitError('webgl');
    await expect(t.start()).rejects.toBeInstanceOf(SceneInitError);
    expect(t.surface.alive).toBe(false);
    expect(t.loop.running).toBe(false);
    t.renderer.destroy();
  });

  it('reports nothing when it was destroyed before a failing setup ended (StrictMode double mount)', async () => {
    const t = setup();
    let open!: () => void;
    t.surface.gate = new Promise<void>((r) => {
      open = r;
    });
    t.surface.failInit = new SceneInitError('webgl');
    const starting = t.start();
    t.renderer.destroy();
    open();
    await expect(starting).resolves.toBeUndefined();
    expect(t.surface.alive).toBe(false);
    t.surface.emit('lost');
    expect(t.onContext).not.toHaveBeenCalled();
    expect(t.onQuality).not.toHaveBeenCalled();
  });
});
