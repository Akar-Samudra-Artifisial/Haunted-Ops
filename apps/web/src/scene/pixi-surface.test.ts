import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { FULL, NOW, REDUCED, house, scene } from '../test/scene-fakes.js';
import { huntOf } from '../test/hunt-arbs.js';
import { createAnimator } from './animator.js';
import { SceneInitError } from './surface.js';
import type * as TexturesModule from './textures.js';

/**
 * Drives the real PixiSurface (init, layout, model, draw, destroy) against a small stand-in for
 * pixi.js, so the lifecycle and the release of resources are tested without WebGL. The e2e test
 * covers the real renderer.
 */
const pixi = vi.hoisted(() => {
  const state = {
    apps: [] as Array<{ destroy: Mock; render: Mock; canvas: HTMLCanvasElement; stage: unknown }>,
    texts: 0,
    created: { graphics: 0, sprites: 0 },
    textures: 0,
    failInit: false,
    gate: null as Promise<void> | null,
  };
  class Point {
    x = 0;
    y = 0;
    set(x: number, y = x): void {
      this.x = x;
      this.y = y;
    }
  }
  class Container {
    children: Container[] = [];
    position = new Point();
    anchor = new Point();
    visible = true;
    alpha = 1;
    destroyed = false;
    addChild(...c: Container[]): Container {
      this.children.push(...c);
      return c[0] as Container;
    }
    removeChildren(): Container[] {
      return this.children.splice(0);
    }
    destroy(): void {
      this.destroyed = true;
    }
  }
  class Graphics extends Container {
    ops = 0;
    constructor() {
      super();
      state.created.graphics += 1;
    }
    private chain(): this {
      this.ops += 1;
      return this;
    }
    clear(): this {
      this.ops = 0;
      return this;
    }
    poly(): this {
      return this.chain();
    }
    fill(): this {
      return this.chain();
    }
    stroke(): this {
      return this.chain();
    }
    roundRect(): this {
      return this.chain();
    }
    circle(): this {
      return this.chain();
    }
    rect(): this {
      return this.chain();
    }
    arc(): this {
      return this.chain();
    }
  }
  class Sprite extends Container {
    constructor() {
      super();
      state.created.sprites += 1;
    }
    width = 0;
    height = 0;
    tint = 0;
    blendMode = 'normal';
  }
  class Text extends Container {
    text: string;
    style: { fontSize: number; fill: string };
    constructor(opts: { text: string; style: { fontSize: number; fill: string } }) {
      super();
      state.texts += 1;
      this.text = opts.text;
      this.style = { ...opts.style };
    }
    get width(): number {
      return this.text.length * this.style.fontSize * 0.55;
    }
    get height(): number {
      return this.style.fontSize;
    }
  }
  class Particle {
    x = 0;
    y = 0;
    scaleX = 1;
    scaleY = 1;
    alpha = 0;
    rotation = 0;
    constructor(opts: Record<string, unknown>) {
      Object.assign(this, opts);
    }
  }
  class ParticleContainer extends Container {
    particles: Particle[] = [];
    addParticle(p: Particle): void {
      this.particles.push(p);
    }
  }
  const Texture = {
    from(canvas: { height: number }) {
      state.textures += 1;
      return { height: canvas.height };
    },
  };
  class Application {
    canvas = document.createElement('canvas');
    stage = new Container();
    renderer = { resize: vi.fn() };
    render = vi.fn();
    destroy = vi.fn();
    constructor() {
      state.apps.push(this);
    }
    async init(): Promise<void> {
      if (state.gate) await state.gate;
      if (state.failInit) throw new Error('no context');
    }
  }
  return { state, Application, Container, Graphics, Sprite, Text, Particle, ParticleContainer, Texture };
});

vi.mock('pixi.js', () => ({
  Application: pixi.Application,
  Container: pixi.Container,
  Graphics: pixi.Graphics,
  Sprite: pixi.Sprite,
  Text: pixi.Text,
  Particle: pixi.Particle,
  ParticleContainer: pixi.ParticleContainer,
  Texture: pixi.Texture,
}));
// jsdom has no 2D canvas: hand back a sized stand-in for every recipe.
vi.mock('./textures.js', async (importOriginal) => {
  const real = await importOriginal<typeof TexturesModule>();
  return { ...real, drawTexture: (name: keyof typeof real.TEXTURE_RECIPES) => ({ width: real.TEXTURE_RECIPES[name].width, height: real.TEXTURE_RECIPES[name].height }) };
});

const { PixiSurface } = await import('./pixi-surface.js');

const incident = { id: 'inc', openedAt: '2026-11-13T10:00:00.000Z', peakLevel: 2 as const };
const metrics = { errorRate: 0.4, p95Ms: 2400, up: 1, at: 'x' };

function setup() {
  const host = document.createElement('div');
  const s = scene(house({ payments: { hauntLevel: 2, reason: { kind: 'error_rate', value: 0.4 }, metrics, openIncident: incident } }), FULL);
  const surface = new PixiSurface();
  const init = () => surface.init({ host, width: s.layout.width, height: s.layout.height, dpr: 1, quality: 'full' });
  return { host, s, surface, init };
}

beforeEach(() => {
  pixi.state.apps = [];
  pixi.state.texts = 0;
  pixi.state.created = { graphics: 0, sprites: 0 };
  pixi.state.textures = 0;
  pixi.state.failInit = false;
  pixi.state.gate = null;
});
afterEach(() => vi.clearAllMocks());

describe('PixiSurface', () => {
  it('starts, draws and on destroy releases the application, the textures and the context listeners, once', async () => {
    const { host, s, surface, init } = setup();
    await init();
    const app = pixi.state.apps[0]!;
    expect(host.contains(app.canvas)).toBe(true);
    // The ghost, two fog puffs, three noise clouds, the mote and the glow.
    expect(pixi.state.textures).toBe(8);
    const onContext = vi.fn();
    surface.onContext(onContext);
    surface.applyLayout(s.layout);
    surface.applyModel(s.model);
    const a = createAnimator();
    a.setLayout(s.layout);
    a.setModel(s.model);
    surface.draw(a.step(16, 16));
    expect(app.render).toHaveBeenCalledTimes(1);
    app.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(onContext).toHaveBeenCalledWith('lost');

    surface.destroy();
    surface.destroy();
    expect(app.destroy).toHaveBeenCalledTimes(1);
    expect(app.destroy.mock.calls[0]).toEqual([{ removeView: true }, { children: true, texture: true, textureSource: true }]);
    // After destroy: no listener, no drawing, no work on a new layout or model.
    app.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(onContext).toHaveBeenCalledTimes(1);
    surface.draw(a.step(16, 32));
    surface.applyLayout(s.layout);
    surface.applyModel(s.model);
    expect(app.render).toHaveBeenCalledTimes(1);
  });

  it('releases the application when destroyed while it is starting, and never adds the canvas', async () => {
    const { host, surface, init } = setup();
    let open!: () => void;
    pixi.state.gate = new Promise<void>((r) => {
      open = r;
    });
    const starting = init();
    surface.destroy();
    open();
    await starting;
    const app = pixi.state.apps[0]!;
    expect(app.destroy).toHaveBeenCalledTimes(1);
    expect(host.contains(app.canvas)).toBe(false);
    expect(pixi.state.textures).toBe(0);
  });

  it('rejects with SceneInitError when no context can be created', async () => {
    const { init } = setup();
    pixi.state.failInit = true;
    await expect(init()).rejects.toBeInstanceOf(SceneInitError);
  });

  it('draws a Hunt with objects made once: no new Text, Graphics or Sprite per frame, and no figure without a Hunt', async () => {
    const { host, surface, init } = setup();
    await init();
    const running = huntOf({ status: 'running', startedAt: NOW - 20_000, stepCount: 3 });
    const s = scene(house({ payments: { hauntLevel: 3, reason: { kind: 'error_rate', value: 0.4 }, metrics, openIncident: incident, hunt: running } }), FULL);
    surface.applyLayout(s.layout);
    surface.applyModel(s.model);
    const a = createAnimator();
    a.setLayout(s.layout);
    a.setModel(s.model);
    const made = (): number => pixi.state.created.graphics + pixi.state.created.sprites + pixi.state.texts;
    surface.draw(a.step(16, 0));
    const before = made();
    for (let t = 1; t <= 120; t++) surface.draw(a.step(16, t * 16));
    expect(made()).toBe(before);
    expect(host.querySelector('canvas')).not.toBeNull();
    // The room without a Hunt has a hidden figure.
    const frame = a.step(16, 2000);
    expect(frame.rooms.find((r) => r.name === 'payments')?.hunt.figure).toBeCloseTo(1, 3);
    expect(frame.rooms.find((r) => r.name === 'gate')?.hunt.figure).toBe(0);
    surface.destroy();
  });

  describe('the mist of a Hunt (Feature: visual-refresh, part 3, C)', () => {
    type Node = { children: Node[]; alpha: number; tint?: number; width?: number; blendMode?: string; visible: boolean; position: { x: number; y: number } };
    const ECTO = 0x9bf2c4;

    function find(node: Node, test: (n: Node) => boolean, out: Node[] = []): Node[] {
      if (test(node)) out.push(node);
      for (const c of node.children) find(c, test, out);
      return out;
    }

    async function hunted(options = FULL, quality: 'full' | 'low' = 'full') {
      const host = document.createElement('div');
      const running = huntOf({ status: 'running', startedAt: NOW - 20_000, stepCount: 3 });
      const s = scene(house({ payments: { hauntLevel: 2, reason: { kind: 'error_rate', value: 0.4 }, metrics, openIncident: incident, hunt: running } }), options);
      const surface = new PixiSurface();
      await surface.init({ host, width: s.layout.width, height: s.layout.height, dpr: 1, quality });
      surface.applyLayout(s.layout);
      surface.applyModel(s.model);
      const a = createAnimator();
      a.setLayout(s.layout);
      a.setModel(s.model);
      const stage = pixi.state.apps[pixi.state.apps.length - 1]!.stage as unknown as Node;
      const room = s.layout.rooms.find((r) => r.name === 'payments')!;
      const mine = (): Node[] => find(stage, (n) => n.tint === ECTO && Math.hypot(n.position.x - room.center.x, n.position.y - room.center.y) < 1.2 * s.layout.scale);
      let t = 0;
      const run = (ms: number): void => {
        for (let e = 0; e < ms; e += 16) {
          t += 16;
          surface.draw(a.step(16, t));
        }
      };
      return { s, surface, room, stage, mine, run };
    }

    it('shows the green mist over the room that is hunted: visible, ecto, above the floor and the glow, wide, clear of the other rooms', async () => {
      const { s, surface, room, stage, mine, run } = await hunted();
      run(4000);
      const mist = mine();
      expect(mist.length).toBeGreaterThan(0);
      for (const sp of mist) {
        expect(sp.visible).toBe(true);
        expect(sp.tint).toBe(ECTO);
        expect(sp.width).toBeGreaterThanOrEqual(0.6 * room.hit.w);
      }
      // The first mist sprite is dense enough to read against the danger glow: alpha of 0.6 or more.
      expect(Math.max(...mist.map((sp) => sp.alpha))).toBeGreaterThanOrEqual(0.6);
      // Drawn above the floor (the body) and the lamp glow (a sprite in additive blend) of the same room, in the rooms layer.
      const root = find(stage, (n) => n.children.includes(mist[0]!))[0]!;
      const glowAt = root.children.findIndex((c) => c.blendMode === 'add');
      expect(glowAt).toBeGreaterThan(0);
      for (const sp of mist) expect(root.children.indexOf(sp)).toBeGreaterThan(glowAt);
      // Below the chip layer: the texts container comes after the rooms container on the stage.
      const roomsLayer = find(stage, (n) => n.children.includes(root))[0]!;
      const order = stage.children.indexOf(roomsLayer);
      expect(order).toBeGreaterThanOrEqual(0);
      // The other rooms have no visible mist.
      const others = find(stage, (n) => n.tint === ECTO && !mist.includes(n) && n.alpha > 0.01 && n.visible && (n.width ?? 0) > 100);
      expect(others.filter((n) => Math.hypot(n.position.x - room.center.x, n.position.y - room.center.y) >= 1.2 * s.layout.scale && n.blendMode !== 'add').length).toBe(0);
      surface.destroy();
    });

    it('breathes slowly: a cycle of 2 s or more, a swing of 0.15 or less, and never below 0.6', async () => {
      const { surface, mine, run } = await hunted();
      run(3000);
      const samples: number[] = [];
      for (let i = 0; i < 400; i++) {
        run(16);
        samples.push(Math.max(...mine().map((sp) => sp.alpha)));
      }
      expect(Math.min(...samples)).toBeGreaterThanOrEqual(0.6);
      expect(Math.max(...samples) - Math.min(...samples)).toBeLessThanOrEqual(0.15);
      // One rise and one fall take at least 2 s: no sample-to-sample step is larger than the swing over 1 s allows.
      let maxStep = 0;
      for (let i = 1; i < samples.length; i++) maxStep = Math.max(maxStep, Math.abs(samples[i]! - samples[i - 1]!));
      expect(maxStep).toBeLessThanOrEqual(0.15 * ((2 * Math.PI * 16) / 2000));
      surface.destroy();
    });

    it('stands still but stays visible under Reduced motion, and stays in Low quality', async () => {
      const still = await hunted(REDUCED);
      still.run(4000);
      const a = still.mine().map((sp) => [sp.alpha, sp.position.x, sp.position.y]);
      still.run(1500);
      expect(still.mine().map((sp) => [sp.alpha, sp.position.x, sp.position.y])).toEqual(a);
      expect(Math.max(...still.mine().map((sp) => sp.alpha))).toBeGreaterThanOrEqual(0.6);
      still.surface.destroy();
      const low = await hunted({ reducedMotion: false, quality: 'low' }, 'low');
      low.run(4000);
      expect(Math.max(...low.mine().map((sp) => sp.alpha))).toBeGreaterThanOrEqual(0.6);
      expect(low.mine().filter((sp) => sp.alpha > 0.01)).toHaveLength(1);
      low.surface.destroy();
    });
  });

  it('reuses the incident mark texts on every model change', async () => {
    const { s, surface, init } = setup();
    await init();
    surface.applyLayout(s.layout);
    surface.applyModel(s.model);
    const after = pixi.state.texts;
    for (let i = 0; i < 5; i++) surface.applyModel(s.model);
    const calm = scene(house(), FULL);
    surface.applyModel(calm.model);
    surface.applyModel(s.model);
    expect(pixi.state.texts).toBe(after);
    surface.destroy();
  });
});
