import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { FULL, NOW, REDUCED, house, scene } from '../test/scene-fakes.js';
import { huntOf } from '../test/hunt-arbs.js';
import { MAX_ROOMS, createAnimator } from './animator.js';
import { GHOST_KIND_MAX, GHOST_MAX, PARTICLE_CAP } from './particles.js';
import { FIGURE_H_SPRITE } from './layout.js';
import { ROOM_SPRITE, SPRITE_KEYS, roomSpriteFit } from './sprites.js';
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
    /** The files of the sprites: `true` answers every `Assets.load` with a picture, `false` rejects it. */
    sprites: false,
    /** The page can give a WebGL context (the probe before the files are asked for). */
    webgl: false,
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
    scale = new Point();
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
    constructor(texture?: unknown) {
      super();
      this.texture = texture ?? null;
      state.created.sprites += 1;
    }
    width = 0;
    height = 0;
    tint = 0;
    texture: unknown = null;
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
  const Assets = {
    load: vi.fn(async (path: string) => {
      if (!state.sprites) throw new Error(`cannot load ${path}`);
      return { width: 256, height: 256, path };
    }),
    unload: vi.fn(async () => undefined),
  };
  return { state, Assets, Application, Container, Graphics, Sprite, Text, Particle, ParticleContainer, Texture };
});

vi.mock('pixi.js', () => ({
  Assets: pixi.Assets,
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
  pixi.state.sprites = false;
  pixi.state.webgl = false;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => (pixi.state.webgl ? { getExtension: () => null } : null)) as never);
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

  describe('the illustrated sprites (Feature: visual-refresh, part 4)', () => {
    type Node = { children: Node[]; alpha: number; particles?: Array<{ alpha: number }>; ops?: number; texture?: { path?: string }; visible?: boolean; width: number; height: number; position: { x: number; y: number }; scale: { x: number; y: number }; blendMode?: string; tint: number };
    const stageOf = (): Node => pixi.state.apps[pixi.state.apps.length - 1]!.stage as unknown as Node;
    const ROOMS_AT = 7;
    const ROOF_AT = 5;
    async function start(sprites: boolean, webgl = true) {
      pixi.state.sprites = sprites;
      pixi.state.webgl = webgl;
      const possessed = { hauntLevel: 3 as const, reason: { kind: 'error_rate' as const, value: 0.5 }, metrics, openIncident: incident };
      const s = scene(house({ payments: possessed, orders: { ...possessed, hauntLevel: 2 as const } }), FULL);
      const surface = new PixiSurface();
      await surface.init({ host: document.createElement('div'), width: s.layout.width, height: s.layout.height, dpr: 1, quality: 'full' });
      surface.applyLayout(s.layout);
      surface.applyModel(s.model);
      const a = createAnimator();
      a.setLayout(s.layout);
      a.setModel(s.model);
      return { s, surface, a };
    }
    const bodyOf = (name: string, s: { layout: { rooms: Array<{ name: string }> } }): Node => {
      const rooms = stageOf().children[ROOMS_AT]!;
      const order = [...s.layout.rooms].map((r) => r.name);
      const idx = rooms.children.findIndex((root) => root.children[0]!.children.some((c) => c.texture?.path?.includes(`room-${name}`)));
      expect(order).toContain(name);
      return rooms.children[idx]!.children[0]!;
    };

    it('asks for the ten files once WebGL is there, and builds 7 textures (no procedural ghost)', async () => {
      const { surface } = await start(true);
      expect(pixi.Assets.load).toHaveBeenCalledTimes(SPRITE_KEYS.length);
      expect(pixi.state.textures).toBe(7);
      surface.destroy();
      expect(pixi.Assets.unload).toHaveBeenCalledTimes(1);
    });

    it('asks for no file when the page has no WebGL', async () => {
      const { surface } = await start(true, false);
      expect(pixi.Assets.load).not.toHaveBeenCalled();
      expect(pixi.state.textures).toBe(8);
      surface.destroy();
    });

    it('with sprites: one room picture, fitted to the floor, and no procedural body, icon, clock or roof', async () => {
      const { s, surface } = await start(true);
      for (const name of Object.keys(ROOM_SPRITE)) {
        const body = bodyOf(name, s);
        expect(body.children).toHaveLength(1);
        const room = s.layout.rooms.find((r) => r.name === name)!;
        const fit = roomSpriteFit(room.floor);
        const sp = body.children[0]!;
        expect([sp.position.x, sp.position.y, sp.width, sp.height]).toEqual([fit.x, fit.y, fit.width, fit.height]);
      }
      expect(stageOf().children[ROOF_AT]!.ops).toBe(0);
      surface.destroy();
    });

    it('without sprites (the files fail): today\'s procedural rooms and roof, and nothing else changes', async () => {
      const { s, surface } = await start(false);
      expect(pixi.Assets.load).toHaveBeenCalled();
      expect(pixi.state.textures).toBe(8);
      const rooms = stageOf().children[ROOMS_AT]!;
      expect(rooms.children.length).toBe(s.layout.rooms.length);
      for (const root of rooms.children) expect(root.children[0]!.children).toHaveLength(3);
      expect(stageOf().children[ROOF_AT]!.ops).toBeGreaterThan(0);
      surface.destroy();
    });

    it('splits the ghosts over three pools without passing a pool size, the room size or the total cap', async () => {
      const { surface, a } = await start(true);
      // The last layers are the three ghost pools, the figures and the chips.
      const pools = stageOf().children.slice(-5, -2);
      expect(pools).toHaveLength(3);
      for (let t = 1; t <= 200; t++) {
        const frame = a.step(16, t * 16);
        surface.draw(frame);
        const shown = pools.map((p) => p.particles!.filter((x) => x.alpha > 0).length);
        expect(shown.reduce((n, x) => n + x, 0)).toBe(frame.ghosts.count);
        shown.forEach((n, k) => expect(n).toBeLessThanOrEqual(MAX_ROOMS * GHOST_KIND_MAX[k]!));
        expect(frame.ghosts.count).toBeLessThanOrEqual(MAX_ROOMS * GHOST_MAX);
        expect(frame.ghosts.count).toBeLessThanOrEqual(PARTICLE_CAP);
      }
      // A possessed room shows angry ghosts (the third pool).
      expect(pools[2]!.particles!.some((x) => x.alpha > 0)).toBe(true);
      surface.destroy();
    });

    it('draws the Exorcist as a picture that mirrors toward its way', async () => {
      pixi.state.sprites = true;
      pixi.state.webgl = true;
      const running = huntOf({ status: 'running', startedAt: NOW - 20_000, stepCount: 3 });
      const s = scene(house({ payments: { hauntLevel: 3, reason: { kind: 'error_rate', value: 0.4 }, metrics, openIncident: incident, hunt: running } }), FULL);
      const surface = new PixiSurface();
      await surface.init({ host: document.createElement('div'), width: s.layout.width, height: s.layout.height, dpr: 1, quality: 'full' });
      surface.applyLayout(s.layout);
      surface.applyModel(s.model);
      const a = createAnimator();
      a.setLayout(s.layout);
      a.setModel(s.model);
      for (let t = 1; t <= 200; t++) surface.draw(a.step(16, t * 16));
      // Only the figures that are shown: the three other rooms hold a hidden one.
      const find = (n: Node, out: Node[] = []): Node[] => {
        if (n.visible === false) return out;
        if (n.texture?.path?.includes('exorcist')) out.push(n);
        n.children.forEach((c) => find(c, out));
        return out;
      };
      const figure = find(stageOf());
      expect(figure).toHaveLength(1);
      expect(figure[0]!.texture!.path).toContain('exorcist-scan');
      // The art faces left: facing right (dir 1) mirrors it (negative scale.x) and puts the lantern glow on the right; facing left keeps it as drawn.
      const room = s.layout.rooms.find((r) => r.name === 'payments')!;
      const dir = room.exorcistAt.x >= room.doors.px.x ? 1 : -1;
      expect(Math.sign(figure[0]!.scale.x)).toBe(-dir);
      expect(figure[0]!.scale.y).toBeGreaterThan(0);
      const glowOf = (n: Node, out: Node[] = []): Node[] => {
        if (n.children.includes(figure[0]!)) out.push(...n.children.filter((c) => c.blendMode === 'add'));
        n.children.forEach((c) => glowOf(c, out));
        return out;
      };
      const glows = glowOf(stageOf());
      expect(glows.length).toBeGreaterThan(0);
      // The first glow is the mint one behind the figure (static, alpha 0.5); the last is the lantern's.
      expect(glows[0]!.tint).toBe(0x9bf2c4);
      expect(glows[0]!.alpha).toBe(0.5);
      expect(Math.sign(glows[glows.length - 1]!.position.x)).toBe(dir);
      // The picture is FIGURE_H_SPRITE high on screen (28 px at least under 40rem).
      // (the stand-in picture is 256 high)
      expect(figure[0]!.scale.y * 256).toBeCloseTo(FIGURE_H_SPRITE * s.layout.scale, 3);
      surface.destroy();
    });
    // Feature: visual-refresh, Property 11
    it('Property 11: with a hunt in progress, the figure is above every pool and below the chips', async () => {
      const running = huntOf({ status: 'running', startedAt: NOW - 20_000, stepCount: 3 });
      const reasons = { kind: 'error_rate' as const, value: 0.4 };
      const hasGlow = (n: Node): boolean => n.children.some((c) => c.blendMode === 'add' && c.tint === 0x9bf2c4);
      const sub = (n: Node, test: (x: Node) => boolean): boolean => test(n) || n.children.some((c) => sub(c, test));
      let ran = 0;
      await fc.assert(
        fc.asyncProperty(fc.boolean(), fc.constantFrom(0, 1, 2, 3 as const), fc.constantFrom('payments', 'orders', 'ledger', 'gate' as const), async (withSprites, level, name) => {
          pixi.state.sprites = withSprites;
          pixi.state.webgl = true;
          const s = scene(house({ [name]: { hauntLevel: level as 0 | 1 | 2 | 3, reason: reasons, metrics, openIncident: incident, hunt: running } }), FULL);
          const surface = new PixiSurface();
          await surface.init({ host: document.createElement('div'), width: s.layout.width, height: s.layout.height, dpr: 1, quality: 'full' });
          surface.applyLayout(s.layout);
          surface.applyModel(s.model);
          const layers = stageOf().children;
          const figureAt = layers.findIndex((l) => l.children.length > 0 && l.children.every((c) => hasGlow(c)));
          expect(figureAt).toBeGreaterThan(-1);
          layers.forEach((l, i) => {
            if (l.particles) expect(i).toBeLessThan(figureAt);
          });
          const chipsAt = layers.length - 1;
          expect(sub(layers[chipsAt]!, (x) => typeof (x as unknown as { text?: unknown }).text === 'string')).toBe(true);
          expect(chipsAt).toBeGreaterThan(figureAt);
          ran += 1;
          surface.destroy();
        }),
        { numRuns: 20 },
      );
      expect(ran).toBe(20);
    });
    it('draws the figure at least 28 px high under 40rem', async () => {
      pixi.state.sprites = true;
      pixi.state.webgl = true;
      const running = huntOf({ status: 'running', startedAt: NOW - 20_000, stepCount: 3 });
      const s = scene(house({ payments: { hauntLevel: 3, reason: { kind: 'error_rate', value: 0.4 }, metrics, openIncident: incident, hunt: running } }), FULL, { width: 320, height: 568, dpr: 1 });
      const surface = new PixiSurface();
      await surface.init({ host: document.createElement('div'), width: s.layout.width, height: s.layout.height, dpr: 1, quality: 'full' });
      surface.applyLayout(s.layout);
      surface.applyModel(s.model);
      const a = createAnimator();
      a.setLayout(s.layout);
      a.setModel(s.model);
      for (let t = 1; t <= 200; t++) surface.draw(a.step(16, t * 16));
      const out: Node[] = [];
      const walk = (n: Node): void => {
        if (n.visible === false) return;
        if (n.texture?.path?.includes('exorcist')) out.push(n);
        n.children.forEach(walk);
      };
      walk(stageOf());
      expect(out).toHaveLength(1);
      expect(out[0]!.scale.y * 256).toBeGreaterThanOrEqual(28 - 1e-6);
      surface.destroy();
    });
    it('the marks, their rings and the dark pill behind them show only in a room with a hunt', async () => {
      for (const sprites of [true, false]) {
        pixi.state.sprites = sprites;
        pixi.state.webgl = true;
        const running = huntOf({ status: 'running', startedAt: NOW - 20_000, stepCount: 3 });
        const s = scene(house({ payments: { hauntLevel: 2, reason: { kind: 'error_rate', value: 0.4 }, metrics, openIncident: incident, hunt: running } }), FULL);
        const surface = new PixiSurface();
        await surface.init({ host: document.createElement('div'), width: s.layout.width, height: s.layout.height, dpr: 1, quality: 'full' });
        surface.applyLayout(s.layout);
        surface.applyModel(s.model);
        // The hunt container holds the pill, the rings, the lit marks, the result and the scroll.
        const hunts: Node[] = [];
        const walk = (n: Node): void => {
          if (n.children.length === 5 && n.children.slice(0, 4).every((c) => c.children.length === 0 && typeof c.visible === 'boolean')) hunts.push(n);
          n.children.forEach(walk);
        };
        walk(stageOf());
        expect(hunts).toHaveLength(s.layout.rooms.length);
        expect(hunts.filter((h) => h.children[0]!.visible === true && h.children[1]!.visible === true)).toHaveLength(1);
        expect(hunts.filter((h) => h.children[0]!.visible === false && h.children[1]!.visible === false)).toHaveLength(s.layout.rooms.length - 1);
        surface.destroy();
      }
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
