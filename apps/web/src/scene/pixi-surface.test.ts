import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { FULL, house, scene } from '../test/scene-fakes.js';
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
    apps: [] as Array<{ destroy: Mock; render: Mock; canvas: HTMLCanvasElement }>,
    texts: 0,
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
  }
  class Sprite extends Container {
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
    expect(pixi.state.textures).toBe(5);
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
