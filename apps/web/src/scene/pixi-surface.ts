import { Application, Container, Graphics, Particle, ParticleContainer, Sprite, Text, Texture } from 'pixi.js';
import type { ServiceName } from '@haunted-ops/shared';
import { MAX_PULSES, MAX_ROOMS } from './animator.js';
import { FIGURE_H, FIGURE_W } from './layout.js';
import { MAX_MARKS } from './model.js';
import { clamp } from './math.js';
import type { Pt, RoomLayout, SceneLayout } from './layout.js';
import type { RoomVisual, SceneModel } from './model.js';
import { FONT_STACK, PALETTE, PILL_ALPHA, hexToNumber } from './palette.js';
import { FOG_BANK_MAX, FOG_WISP_MAX, GHOST_MAX, MOTE_MAX } from './particles.js';
import { CORRIDOR_STYLE, buildHouseArt, buildRoomArt, clockHands, pillRect, plaqueLayout, starField, type RoomArt, type RoomIcon } from './shapes.js';
import { FOG_LAYERS, SceneInitError, type Frame, type HuntFrame, type ParticleBuffer, type RoomFrame, type Surface, type SurfaceInit } from './surface.js';
import { TEXTURE_NAMES, drawTexture, type TextureName } from './textures.js';

const num = hexToNumber;
const flat = (points: readonly Pt[]): number[] => points.flatMap((p) => [p.x, p.y]);

function mixColor(a: number, b: number, t: number): number {
  const k = clamp(t, 0, 1);
  const ch = (shift: number): number => Math.round(((a >> shift) & 255) * (1 - k) + ((b >> shift) & 255) * k);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** A fixed pool of particles of one texture; unused ones are invisible. */
class Pool {
  readonly container: ParticleContainer;
  private readonly particles: Particle[] = [];
  private readonly texH: number;

  constructor(texture: Texture, capacity: number, tint: string, anchorY: number) {
    this.texH = texture.height;
    this.container = new ParticleContainer({
      texture,
      dynamicProperties: { position: true, vertex: true, rotation: true, color: true },
    });
    for (let i = 0; i < capacity; i++) {
      const p = new Particle({ texture, x: 0, y: 0, anchorX: 0.5, anchorY, tint: num(tint), alpha: 0 });
      this.particles.push(p);
      this.container.addParticle(p);
    }
  }

  fill(buf: ParticleBuffer): void {
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i] as Particle;
      if (i < buf.count) {
        // `size` is the sprite height: a wide texture (the fog bank) keeps its aspect.
        const s = (buf.size[i] as number) / this.texH;
        p.x = buf.x[i] as number;
        p.y = buf.y[i] as number;
        p.scaleX = s;
        p.scaleY = s;
        p.alpha = buf.alpha[i] as number;
        p.rotation = buf.rotation[i] as number;
      } else {
        p.alpha = 0;
      }
    }
  }
}

interface RoomView {
  room: RoomLayout;
  art: RoomArt;
  root: Container;
  /** Nameplate, incident mark, reason badge and hunt slot: above the fog, below the ghosts. */
  texts: Container;
  body: Container;
  glow: Sprite;
  dim: Graphics;
  /** Danger tint over floor and walls. */
  tint: Graphics;
  /** Three soft noise layers of fog, and the two sprites of the Exorcist's mist, made once. */
  fogLayers: Sprite[];
  mist: Sprite[];
  /** Half the floor's width and height: the unit of the drifts. */
  half: { w: number; h: number };
  outlineTrim: Graphics;
  outlineAlarm: Graphics;
  outlineEdge: Graphics;
  clock: Graphics;
  plate: Graphics;
  label: Text;
  badge: Text;
  badgePill: Graphics;
  /** The incident mark: created once, updated in place. */
  incident: Container;
  incidentTri: Graphics;
  incidentBang: Text;
  incidentWord: Text;
  hunt: Container;
  huntArt: HuntArt;
}

/** Points of the seal ring; it is drawn as the first `n` segments. */
const SEAL_STEPS = 48;
/** A fizzle throws at most this many spark dots (Graphics, not particles). */
const SPARK_COUNT = 6;

/** The objects of one room's hunt, made once. */
interface HuntArt {
  container: Container;
  marksOn: Graphics;
  result: Graphics;
  seal: Graphics;
  figure: Container;
  lanternGlow: Sprite;
  lantern: Graphics;
  sparks: Graphics[];
  lanternX: number;
  lanternY: number;
  slot: { x: number; y: number; w: number; h: number; midY: number; r: number; markX: (i: number) => number };
  ringPts: number[];
  /** What is drawn now, so a frame redraws a Graphics only when it changed. */
  sealN: number;
  drawnMarks: number;
  drawnResult: 'none' | 'sealed' | 'failed' | null;
  /** The fix scroll (with its glow) and the cleansing ring, made once and only moved or faded. */
  scroll: Container;
  scrollGlow: Sprite;
  sweep: Graphics;
}

interface Layers {
  background: Graphics;
  /** The sky: far stars, near stars and the moon move a little with the camera (parallax). */
  farStars: Graphics;
  nearStars: Graphics;
  moon: Container;
  house: Graphics;
  /** The roof and chimney: solid, and clear while a room is focused. */
  roof: Graphics;
  corridors: Container;
  rooms: Container;
  texts: Container;
  ui: Container;
  ring: Graphics;
}

/**
 * The PixiJS drawing of the scene. The only file that imports `pixi.js`. It draws Frames and
 * decides nothing: all values come from the Animator and the model.
 *
 * Back to front: night sky, house, corridors, rooms, fog bank, fog wisps, motes, corridor pulses,
 * selection ring, texts, ghosts.
 */
export class PixiSurface implements Surface {
  private app: Application | null = null;
  private destroyed = false;
  private host: HTMLElement | null = null;
  private textures = new Map<TextureName, Texture>();
  private pools: { ghosts: Pool; fog: Pool; fogBank: Pool; motes: Pool; pulses: Pool } | null = null;
  private layers: Layers | null = null;
  private views = new Map<ServiceName, RoomView>();
  private corridors: Array<{ base: Graphics; lit: Graphics }> = [];
  private layout: SceneLayout | null = null;
  private model: SceneModel | null = null;
  private quality: 'full' | 'low' = 'full';
  private dpr = 1;
  private size = { width: 0, height: 0 };
  private contextCb: ((e: 'lost' | 'restored') => void) | null = null;
  private ringFor: ServiceName | null = null;
  private readonly cleanups: Array<() => void> = [];

  async init(opts: SurfaceInit): Promise<void> {
    this.host = opts.host;
    this.quality = opts.quality;
    this.dpr = opts.dpr;
    this.size = { width: opts.width, height: opts.height };
    const app = new Application();
    try {
      await app.init({
        width: opts.width,
        height: opts.height,
        resolution: this.resolution(),
        autoDensity: true,
        antialias: true,
        background: PALETTE.night,
        // WebGL first, then WebGPU. The 2D canvas renderer is left out on purpose: without a GPU
        // context the mount shows the fallback message and Table mode is the full view.
        preference: ['webgl', 'webgpu'],
        autoStart: false,
        sharedTicker: false,
      });
    } catch {
      throw new SceneInitError('webgl');
    }
    if (this.destroyed) {
      app.destroy({ removeView: true }, { children: true, texture: true, textureSource: true });
      return;
    }
    this.app = app;
    const canvas = app.canvas;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    opts.host.appendChild(canvas);

    for (const name of TEXTURE_NAMES) this.textures.set(name, Texture.from(drawTexture(name)));
    const ring = new Graphics();
    const ui = new Container();
    ui.addChild(ring);
    const moon = new Container();
    moon.addChild(new Sprite(this.textures.get('glow') as Texture), new Graphics());
    const layers: Layers = { background: new Graphics(), farStars: new Graphics(), nearStars: new Graphics(), moon, house: new Graphics(), roof: new Graphics(), corridors: new Container(), rooms: new Container(), texts: new Container(), ui, ring };
    this.layers = layers;

    const tex = (n: TextureName): Texture => this.textures.get(n) as Texture;
    const pools = {
      fogBank: new Pool(tex('fogBank'), MAX_ROOMS * FOG_BANK_MAX, PALETTE.fog, 0.5),
      fog: new Pool(tex('fog'), MAX_ROOMS * FOG_WISP_MAX, PALETTE.fog, 0.5),
      ghosts: new Pool(tex('ghost'), MAX_ROOMS * GHOST_MAX, PALETTE.ghost, 1),
      motes: new Pool(tex('mote'), MAX_ROOMS * MOTE_MAX, PALETTE.lampWarm, 0.5),
      pulses: new Pool(tex('mote'), MAX_PULSES, PALETTE.lampWarm, 0.5),
    };
    this.pools = pools;
    app.stage.addChild(
      layers.background,
      layers.farStars,
      layers.nearStars,
      layers.moon,
      layers.house,
      layers.roof,
      layers.corridors,
      layers.rooms,
      pools.fogBank.container,
      pools.fog.container,
      pools.motes.container,
      pools.pulses.container,
      // The ring runs along the silhouette, through the front corner: the nameplate stays on top of it.
      layers.ui,
      layers.texts,
      pools.ghosts.container,
    );

    const onLost = (e: Event): void => {
      e.preventDefault();
      this.contextCb?.('lost');
    };
    const onRestored = (): void => this.contextCb?.('restored');
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    this.cleanups.push(() => canvas.removeEventListener('webglcontextlost', onLost), () => canvas.removeEventListener('webglcontextrestored', onRestored));
  }

  private resolution(): number {
    return this.quality === 'low' ? 1 : Math.min(this.dpr, 2);
  }

  onContext(cb: (e: 'lost' | 'restored') => void): void {
    this.contextCb = cb;
  }

  resize(width: number, height: number, dpr: number): void {
    this.size = { width, height };
    this.dpr = dpr;
    this.app?.renderer.resize(width, height, this.resolution());
  }

  setQuality(quality: 'full' | 'low'): void {
    this.quality = quality;
    this.app?.renderer.resize(this.size.width, this.size.height, this.resolution());
  }

  applyLayout(layout: SceneLayout): void {
    const layers = this.layers;
    if (!this.app || !layers) return;
    this.layout = layout;

    layers.background.clear();
    layers.background.rect(0, 0, layout.width, layout.height).fill({ color: num(PALETTE.night) });
    // A soft horizon: bands of wall colour, stronger toward the bottom.
    for (let i = 0; i < 6; i++) layers.background.rect(0, layout.height * (0.5 + 0.083 * i), layout.width, layout.height * 0.09).fill({ color: num(PALETTE.wallLeft), alpha: 0.035 * (i + 1) });
    layers.farStars.clear();
    for (const s of starField(layout.width, layout.height, 40, 7)) layers.farStars.circle(s.x, s.y, s.r * 0.8).fill({ color: num(PALETTE.ghost), alpha: s.alpha * 0.7 });
    layers.nearStars.clear();
    for (const s of starField(layout.width, layout.height, 16, 19)) layers.nearStars.circle(s.x, s.y, s.r * 1.4).fill({ color: num(PALETTE.ghost), alpha: Math.min(1, s.alpha + 0.2) });
    // The moon: a pale disc with a bite taken out of it, in a soft halo.
    const mr = Math.max(6, Math.min(layout.width, layout.height) * 0.04);
    const [halo, disc] = layers.moon.children as [Sprite, Graphics];
    layers.moon.position.set(0, 0);
    halo.anchor.set(0.5);
    halo.position.set(layout.width * 0.88, layout.height * 0.13);
    halo.width = mr * 7;
    halo.height = mr * 7;
    halo.tint = num(PALETTE.moon);
    halo.alpha = 0.3;
    disc.clear();
    disc.circle(layout.width * 0.88, layout.height * 0.13, mr).fill({ color: num(PALETTE.moon), alpha: 0.85 });
    disc.circle(layout.width * 0.88 + mr * 0.45, layout.height * 0.13 - mr * 0.2, mr * 0.85).fill({ color: num(PALETTE.night) });

    const g = layers.house;
    g.clear();
    if (layout.house) {
      const art = buildHouseArt(layout.house, layout.scale);
      // The roof and chimney are the first two shapes: they are drawn on their own layer.
      for (const poly of art.polys.slice(art.roof.polys.length)) g.poly(flat(poly.points), true).fill({ color: num(poly.fill), alpha: poly.alpha });
      g.circle(art.window.center.x, art.window.center.y, art.window.radius).fill({ color: num(art.window.fill), alpha: art.window.alpha });
      for (const line of [...art.window.bars, ...art.lines.slice(art.roof.lines.length)]) {
        g.poly(flat(line.points), false).stroke({ color: num(line.color), alpha: line.alpha, width: line.width, join: 'round', cap: 'round' });
      }
      const roof = layers.roof;
      roof.clear();
      for (const poly of art.roof.polys) roof.poly(flat(poly.points), true).fill({ color: num(poly.fill), alpha: poly.alpha });
      for (const line of art.roof.lines) roof.poly(flat(line.points), false).stroke({ color: num(line.color), alpha: line.alpha, width: line.width, join: 'round', cap: 'round' });
    }

    for (const child of layers.corridors.removeChildren()) child.destroy({ children: true });
    this.corridors = layout.corridors.map((c) => {
      const base = new Graphics();
      const lit = new Graphics();
      base.poly(flat(c.points), false).stroke({ color: num(PALETTE.trim), alpha: CORRIDOR_STYLE.idleAlpha, width: c.width, cap: 'round', join: 'round' });
      lit.poly(flat(c.points), false).stroke({ color: num(PALETTE.lampWarm), alpha: CORRIDOR_STYLE.litAlpha, width: c.width * CORRIDOR_STYLE.litWidth, cap: 'round', join: 'round' });
      layers.corridors.addChild(base, lit);
      return { base, lit };
    });

    for (const child of layers.rooms.removeChildren()) child.destroy({ children: true });
    for (const child of layers.texts.removeChildren()) child.destroy({ children: true });
    this.views.clear();
    const ordered = [...layout.rooms].sort((a, b) => a.grid.x + a.grid.y - (b.grid.x + b.grid.y) || a.grid.x - b.grid.x);
    for (const room of ordered) {
      const view = this.buildRoom(room, layout);
      this.views.set(room.name, view);
      layers.rooms.addChild(view.root);
      layers.texts.addChild(view.texts);
    }
    if (this.model) this.applyModel(this.model);
    this.ringFor = null;
  }

  private buildRoom(room: RoomLayout, layout: SceneLayout): RoomView {
    const art = buildRoomArt(room, layout.scale);
    const root = new Container();
    const body = new Container();
    const base = new Graphics();
    // The floor and the walls first, then the floor gradient and the inner wall panels, then the rug and the lamp shade.
    for (const poly of [...art.polys.slice(0, 3), ...art.detail, ...art.polys.slice(3)]) base.poly(flat(poly.points), true).fill({ color: num(poly.fill), alpha: poly.alpha });
    if (art.icon) this.drawIcon(base, art.icon);
    for (const line of art.lines) base.poly(flat(line.points), false).stroke({ color: num(line.color), alpha: line.alpha, width: line.width, join: 'round' });
    const clockFace = new Graphics();
    const clock = new Graphics();
    clockFace.circle(art.clock.center.x, art.clock.center.y, art.clock.radius).fill({ color: num(PALETTE.nightDeep), alpha: 0.9 }).stroke({ color: num(PALETTE.trim), width: Math.max(1, art.clock.radius * 0.12) });
    body.addChild(base, clockFace, clock);

    const glow = new Sprite(this.textures.get('glow') as Texture);
    glow.anchor.set(0.5);
    glow.position.set(art.lampTop.x, art.lampTop.y);
    glow.width = art.glowSize;
    glow.height = art.glowSize;
    glow.blendMode = 'add';
    glow.tint = num(PALETTE.glowWarm);

    const sil = flat(room.silhouette);
    const dim = new Graphics();
    dim.poly(sil, true).fill({ color: num(PALETTE.nightDeep) });
    dim.alpha = 0;
    const outlineTrim = new Graphics();
    outlineTrim.poly(sil, true).stroke({ color: num(PALETTE.trim), width: Math.max(1.5, layout.scale * 0.05), join: 'round' });
    const outlineEdge = new Graphics();
    outlineEdge.poly(sil, true).stroke({ color: num(PALETTE.lightCold), width: Math.max(1, layout.scale * 0.035), join: 'round' });
    outlineEdge.alpha = 0;
    const tint = new Graphics();
    tint.poly(sil, true).fill({ color: num(PALETTE.danger) });
    tint.alpha = 0;
    const [floorTop, floorRight, floorBottom, floorLeft] = room.floor;
    const half = { w: (floorRight.x - floorLeft.x) / 4, h: (floorBottom.y - floorTop.y) / 4 };
    const spriteOf = (name: TextureName, w: number, h: number, color: string, x: number, y: number): Sprite => {
      const sp = new Sprite(this.textures.get(name) as Texture);
      sp.anchor.set(0.5);
      sp.width = w;
      sp.height = h;
      sp.tint = num(color);
      sp.alpha = 0;
      sp.position.set(x, y);
      return sp;
    };
    const mid = { x: (floorLeft.x + floorRight.x) / 2, y: (floorTop.y + floorBottom.y) / 2 };
    const fogLayers = (['noiseA', 'noiseB', 'noiseC'] as const).map((n) => spriteOf(n, half.w * 3, half.h * 3, PALETTE.fog, mid.x, mid.y));
    const mist = (['noiseC', 'noiseA'] as const).map((n) => spriteOf(n, half.w * 3.4, half.h * 3.6, PALETTE.ecto, mid.x, mid.y - half.h * 0.4));
    const outlineAlarm = new Graphics();
    outlineAlarm.poly(sil, true).stroke({ color: num(PALETTE.alarm), width: Math.max(2, layout.scale * 0.07), join: 'round' });
    outlineAlarm.alpha = 0;

    const style = (size: number, fill: string, weight: '600' | '700' = '600') => ({ fontFamily: FONT_STACK, fontSize: size, fill, fontWeight: weight });
    const plate = new Graphics();
    const label = new Text({ text: room.name, style: style(layout.labelPx, PALETTE.text) });
    label.anchor.set(0.5);
    label.position.set(room.labelAt.x, room.labelAt.y);
    const badgePill = new Graphics();
    const badge = new Text({ text: '', style: style(layout.badgePx, PALETTE.text) });
    badge.anchor.set(0.5);
    badge.position.set(room.badgeAt.x, room.badgeAt.y);

    const incident = new Container();
    incident.visible = false;
    const incidentTri = new Graphics();
    const incidentBang = new Text({ text: '!', style: style(layout.badgePx * 0.8, PALETTE.nightDeep, '700') });
    incidentBang.anchor.set(0.5);
    const incidentWord = new Text({ text: 'incident', style: style(layout.badgePx, PALETTE.alarmText) });
    incidentWord.anchor.set(0, 0.5);
    incident.addChild(incidentTri, incidentBang, incidentWord);
    // The hunt: the slot with its marks, the Exorcist figure with its lantern, and the seal ring on the floor.
    const huntArt = this.buildHunt(room, layout);
    const hunt = huntArt.container;

    root.addChild(body, tint, ...fogLayers, glow, dim, ...mist, outlineTrim, outlineEdge, outlineAlarm, huntArt.seal, huntArt.sweep);
    const texts = new Container();
    texts.addChild(badgePill, badge, plate, label, incident, hunt);
    return { room, art, root, texts, body, glow, dim, tint, fogLayers, mist, half, outlineTrim, outlineEdge, outlineAlarm, clock, plate, label, badge, badgePill, incident, incidentTri, incidentBang, incidentWord, hunt, huntArt };
  }

  /** Draws the small icon of a service on the back wall. */
  private drawIcon(g: Graphics, icon: RoomIcon): void {
    for (const poly of icon.polys) g.poly(flat(poly.points), true).fill({ color: num(poly.fill), alpha: poly.alpha });
    for (const d of icon.discs) g.circle(d.center.x, d.center.y, d.radius).fill({ color: num(d.fill), alpha: d.alpha });
    for (const line of icon.lines) g.poly(flat(line.points), false).stroke({ color: num(line.color), alpha: line.alpha, width: line.width, join: 'round', cap: 'round' });
  }

  /** Creates every object of the hunt once; `drawHunt` only moves and recolours them. */
  private buildHunt(room: RoomLayout, layout: SceneLayout): HuntArt {
    const s = layout.scale;
    const container = new Container();
    const slot = room.huntRect;
    const midY = slot.y + slot.h / 2;
    const r = Math.max(1.5, Math.min(slot.h * 0.28, slot.w / 20));
    const step = (slot.w * 0.85) / MAX_MARKS;
    const markX = (i: number): number => slot.x + step * (i + 0.5);

    const marksOff = new Graphics();
    for (let i = 0; i < MAX_MARKS; i++) marksOff.circle(markX(i), midY, r).stroke({ color: num(PALETTE.trim), alpha: 0.55, width: Math.max(1, r * 0.35) });
    const marksOn = new Graphics();
    const result = new Graphics();

    const seal = new Graphics();
    const ringPts: number[] = [];
    const rx = 1.3 * s;
    const ry = 0.65 * s;
    for (let i = 0; i <= SEAL_STEPS; i++) {
      const a = -Math.PI / 2 + (i / SEAL_STEPS) * Math.PI * 2;
      ringPts.push(room.center.x + rx * Math.cos(a), room.center.y + ry * Math.sin(a));
    }

    const figure = new Container();
    const w = FIGURE_W * s;
    const h = FIGURE_H * s;
    const body = new Graphics();
    body.roundRect(-w / 2, -h, w, h, w / 2).fill({ color: num(PALETTE.trim), alpha: 0.95 });
    body.circle(0, -h * 0.82, w * 0.34).fill({ color: num(PALETTE.nightDeep), alpha: 0.9 });
    const lanternX = w * 0.75;
    const lanternY = -h * 0.4;
    const lanternGlow = new Sprite(this.textures.get('glow') as Texture);
    lanternGlow.anchor.set(0.5);
    lanternGlow.position.set(lanternX, lanternY);
    lanternGlow.width = 0.9 * s;
    lanternGlow.height = 0.9 * s;
    lanternGlow.blendMode = 'add';
    lanternGlow.tint = num(PALETTE.glowWarm);
    const lantern = new Graphics();
    lantern.circle(lanternX, lanternY, Math.max(2, 0.06 * s)).fill({ color: num(PALETTE.lampWarm) });
    const sparks: Graphics[] = [];
    for (let i = 0; i < SPARK_COUNT; i++) {
      const spark = new Graphics();
      spark.circle(0, 0, Math.max(1, 0.025 * s)).fill({ color: num(PALETTE.lampWarm) });
      spark.visible = false;
      sparks.push(spark);
    }
    figure.addChild(body, lanternGlow, lantern, ...sparks);
    figure.visible = false;
    figure.position.set(room.doors.px.x, room.doors.px.y);

    // The fix scroll: a parchment sheet with a roll at each end and three ink lines.
    const scroll = new Container();
    const sw = 0.36 * s;
    const sh = 0.46 * s;
    const scrollGlow = new Sprite(this.textures.get('glow') as Texture);
    scrollGlow.anchor.set(0.5);
    scrollGlow.width = 1.1 * s;
    scrollGlow.height = 1.1 * s;
    scrollGlow.blendMode = 'add';
    scrollGlow.tint = num(PALETTE.glowWarm);
    const sheet = new Graphics();
    sheet.rect(-sw / 2, -sh / 2, sw, sh).fill({ color: num(PALETTE.lampWarm), alpha: 0.95 });
    const roll = Math.max(1.5, 0.05 * s);
    sheet.roundRect(-sw / 2 - roll, -sh / 2 - roll, sw + 2 * roll, 2 * roll, roll).fill({ color: num(PALETTE.trim) });
    sheet.roundRect(-sw / 2 - roll, sh / 2 - roll, sw + 2 * roll, 2 * roll, roll).fill({ color: num(PALETTE.trim) });
    for (let i = 0; i < 3; i++) sheet.rect(-sw * 0.32, -sh * 0.22 + i * sh * 0.2, sw * 0.64, Math.max(1, 0.02 * s)).fill({ color: num(PALETTE.nightDeep), alpha: 0.7 });
    scroll.addChild(scrollGlow, sheet);
    scroll.visible = false;

    // The cleansing ring: drawn once at full size, then scaled and faded.
    const sweep = new Graphics();
    const sweepPts: number[] = [];
    for (let i = 0; i < SEAL_STEPS; i++) {
      const a = (i / SEAL_STEPS) * Math.PI * 2;
      sweepPts.push(1.4 * s * Math.cos(a), 0.7 * s * Math.sin(a));
    }
    sweep.poly(sweepPts, true).stroke({ color: num(PALETTE.lampWarm), width: Math.max(2, 0.08 * s) });
    sweep.position.set(room.center.x, room.center.y);
    sweep.visible = false;

    container.addChild(marksOff, marksOn, result, figure, scroll);
    return {
      container,
      marksOn,
      result,
      seal,
      figure,
      lanternGlow,
      lantern,
      sparks,
      lanternX,
      lanternY,
      slot: { x: slot.x, y: slot.y, w: slot.w, h: slot.h, midY, r, markX },
      ringPts,
      sealN: 0,
      drawnMarks: -1,
      drawnResult: null,
      scroll,
      scrollGlow,
      sweep,
    };
  }

  applyModel(model: SceneModel): void {
    this.model = model;
    const layout = this.layout;
    if (!layout) return;
    for (const v of model.rooms) {
      const view = this.views.get(v.name);
      if (!view) continue;
      this.paintTexts(view, v, layout);
    }
  }

  private paintTexts(view: RoomView, v: RoomVisual, layout: SceneLayout): void {
    const { room } = view;
    view.label.text = v.label;
    const text = layout.compact ? v.badgeShort : v.badge;
    view.badge.text = text;
    view.badge.style.fill = v.badgeKind === 'error_rate' ? PALETTE.alarmText : v.badgeKind === 'p95' ? PALETTE.fogText : PALETTE.text;
    view.badge.visible = text !== '';
    view.badgePill.visible = text !== '';
    if (text !== '') this.pill(view.badgePill, pillRect(room.badgeAt, view.badge.width, view.badge.height));

    view.clock.clear();
    for (const hand of clockHands(v.clock, view.art.clock.center, view.art.clock.radius)) {
      view.clock.poly(flat(hand.points), false).stroke({ color: num(hand.color), width: hand.width, cap: 'round' });
    }

    // The nameplate, and the incident mark on it: "⚠ incident" when it fits the room, else "!".
    const s = layout.badgePx;
    const plaque = plaqueLayout({
      room,
      compact: layout.compact,
      open: v.incident.open,
      markPx: s,
      labelW: view.label.width,
      labelH: view.label.height,
      wordW: view.incidentWord.width,
    });
    view.plate.clear();
    const p = plaque.plate;
    view.plate
      .roundRect(p.x, p.y, p.w, p.h, p.r)
      .fill({ color: num(PALETTE.pill), alpha: PILL_ALPHA })
      .stroke({ color: num(PALETTE.lampWarm), alpha: 0.75, width: Math.max(1, 0.03 * layout.scale) });

    const mark = plaque.mark;
    view.incident.visible = mark !== null;
    view.incidentTri.clear();
    if (mark) {
      const { x, y } = mark.tri;
      view.incidentTri.poly([x, y - s * 0.55, x + s * 0.55, y + s * 0.45, x - s * 0.55, y + s * 0.45], true).fill({ color: num(PALETTE.alarm) });
      view.incidentBang.position.set(x, y + s * 0.12);
      view.incidentWord.visible = mark.word !== null;
      if (mark.word) view.incidentWord.position.set(mark.word.x, mark.word.y);
    }
  }

  private pill(g: Graphics, r: { x: number; y: number; w: number; h: number; r: number }): void {
    g.clear();
    g.roundRect(r.x, r.y, r.w, r.h, r.r).fill({ color: num(PALETTE.pill), alpha: PILL_ALPHA });
  }

  draw(frame: Frame): void {
    const app = this.app;
    const layers = this.layers;
    const pools = this.pools;
    const layout = this.layout;
    if (this.destroyed || !app || !layers || !pools || !layout) return;

    for (const rf of frame.rooms) {
      const view = this.views.get(rf.name);
      if (view) this.drawRoom(view, rf);
    }
    for (let i = 0; i < frame.corridors.length; i++) {
      const view = this.corridors[i];
      // The idle line keeps its own alpha; only the warm line follows the light.
      if (view) view.lit.alpha = (frame.corridors[i] as { lit: number }).lit;
    }
    layers.farStars.position.set(frame.parallax.x * 0.3, frame.parallax.y * 0.3);
    layers.nearStars.position.set(frame.parallax.x, frame.parallax.y);
    layers.moon.position.set(frame.parallax.x * 0.15, frame.parallax.y * 0.15);
    layers.roof.alpha = frame.roofAlpha;
    pools.fogBank.fill(frame.fogBank);
    pools.fog.fill(frame.fog);
    pools.ghosts.fill(frame.ghosts);
    pools.motes.fill(frame.motes);
    pools.pulses.fill(frame.pulses);
    this.drawRing(frame.selected, layout);
    app.render();
  }

  private drawRoom(view: RoomView, rf: RoomFrame): void {
    const breath = 1 + 0.03 * (rf.lampBreath * 2 - 1);
    const light = rf.light * rf.flicker;
    view.body.position.set(rf.shakeX, rf.shakeY);
    // The glow is warm in a calm room and turns to the danger colour as the tint grows; a pulse adds one soft swell.
    view.glow.alpha = clamp(light * breath + 0.35 * rf.pulse, 0, 1) * (rf.dark ? 0 : 0.85);
    view.glow.tint = mixColor(num(PALETTE.glowWarm), num(PALETTE.danger), clamp(rf.tint / 0.6, 0, 1));
    view.dim.alpha = clamp(rf.dim + (1 - clamp(light, 0, 1)) * 0.6 * (1 - rf.dim), 0, 0.95);
    view.tint.alpha = clamp(rf.tint * (1 + 0.6 * rf.pulse), 0, 0.8) * (rf.dark ? 0 : 1);
    view.outlineAlarm.alpha = rf.alarm;
    view.outlineEdge.alpha = rf.edge;
    view.outlineTrim.alpha = rf.outlineAlpha;
    for (let k = 0; k < FOG_LAYERS; k++) {
      const layer = rf.fogLayers[k];
      const sp = view.fogLayers[k];
      if (!layer || !sp) continue;
      sp.alpha = layer.alpha;
      sp.position.set(view.room.center.x + layer.x * view.half.w * 2, view.room.center.y + layer.y * view.half.h * 2);
    }
    view.mist[0]!.alpha = 0.5 * rf.mist;
    view.mist[1]!.alpha = 0.35 * rf.mist;
    view.mist[0]!.position.set(view.room.center.x + rf.mistX * view.half.w * 2, view.room.center.y - view.half.h * 0.4 + rf.mistY * view.half.h * 2);
    view.mist[1]!.position.set(view.room.center.x - rf.mistX * view.half.w * 2, view.room.center.y - view.half.h * 0.4 - rf.mistY * view.half.h * 2);
    view.badge.alpha = rf.badgeAlpha;
    view.badgePill.alpha = rf.badgeAlpha;
    this.drawHunt(view, rf.hunt, this.layout?.scale ?? 1);
  }

  /** Moves the figure, recolours the lantern and redraws the marks, the result and the seal only when they change. */
  private drawHunt(view: RoomView, h: HuntFrame, scale: number): void {
    const a = view.huntArt;
    const { slot } = a;
    if (a.drawnMarks !== h.marks) {
      a.drawnMarks = h.marks;
      a.marksOn.clear();
      for (let i = 0; i < h.marks; i++) a.marksOn.circle(slot.markX(i), slot.midY, slot.r).fill({ color: num(PALETTE.lampWarm) });
    }
    if (a.drawnResult !== h.result) {
      a.drawnResult = h.result;
      a.result.clear();
      const cx = slot.x + slot.w * 0.93;
      const rr = Math.max(2, slot.h * 0.34);
      const width = Math.max(1.5, rr * 0.35);
      if (h.result === 'sealed') a.result.circle(cx, slot.midY, rr).stroke({ color: num(PALETTE.lampWarm), width });
      else if (h.result === 'failed') a.result.arc(cx, slot.midY, rr, 0.6, Math.PI * 2 - 0.6).stroke({ color: num(PALETTE.alarm), width });
    }
    const n = Math.ceil(h.seal * SEAL_STEPS);
    if (a.sealN !== n) {
      a.sealN = n;
      a.seal.clear();
      if (n > 0) a.seal.poly(a.ringPts.slice(0, 2 * (n + 1)), false).stroke({ color: num(PALETTE.lampWarm), width: Math.max(2, 0.07 * scale), cap: 'round', join: 'round' });
    }
    a.seal.alpha = h.figure;

    // The fix: glowing at the end of the Hunt slot while drafting (the figure has usually left by then), else
    // pinned on the wall above its start. Both spots stay clear of the badge and the nameplate.
    const p = h.proposal;
    a.scroll.visible = p.scroll > 0.003;
    if (a.scroll.visible) {
      if (p.pinned) a.scroll.position.set(slot.x - 0.3 * scale, slot.y - 0.35 * scale);
      else a.scroll.position.set(slot.x + slot.w + 0.35 * scale, slot.midY - 0.1 * scale);
      a.scroll.alpha = p.scroll;
      a.scrollGlow.alpha = 0.7 * p.glow;
    }
    a.sweep.visible = p.sweep > 0;
    if (p.sweep > 0) {
      a.sweep.scale.set(0.2 + 0.8 * p.sweep);
      a.sweep.alpha = 1 - p.sweep;
    }

    const shown = h.figure > 0.003;
    a.figure.visible = shown;
    if (!shown) return;
    const { doors, exorcistAt } = view.room;
    a.figure.alpha = h.figure;
    a.figure.position.set(doors.px.x + (exorcistAt.x - doors.px.x) * h.walk, doors.px.y + (exorcistAt.y - doors.px.y) * h.walk);
    a.lantern.alpha = h.lantern;
    a.lanternGlow.alpha = 0.75 * h.lantern;
    for (let i = 0; i < a.sparks.length; i++) {
      const spark = a.sparks[i] as Graphics;
      spark.visible = h.sparks > 0;
      if (h.sparks > 0) {
        spark.position.set(a.lanternX + (i - (SPARK_COUNT - 1) / 2) * 0.07 * scale, a.lanternY + h.sparks * (0.35 + 0.05 * i) * scale);
        spark.alpha = 1 - h.sparks;
      }
    }
  }

  private drawRing(selected: ServiceName | null, layout: SceneLayout): void {
    const ring = this.layers?.ring;
    if (!ring || this.ringFor === selected) return;
    this.ringFor = selected;
    ring.clear();
    const room = selected === null ? undefined : layout.rooms.find((r) => r.name === selected);
    if (!room) return;
    ring.poly(flat(room.silhouette), true).stroke({ color: num(PALETTE.ring), width: Math.max(3, layout.scale * 0.09), join: 'round', alpha: 1 });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const off of this.cleanups.splice(0)) off();
    const app = this.app;
    this.app = null;
    this.layers = null;
    this.pools = null;
    this.views.clear();
    this.corridors = [];
    this.textures.clear();
    this.contextCb = null;
    if (app) app.destroy({ removeView: true }, { children: true, texture: true, textureSource: true });
    this.host = null;
  }
}
