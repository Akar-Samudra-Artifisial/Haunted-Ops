import { Application, Container, Graphics, Particle, ParticleContainer, Sprite, Text, Texture } from 'pixi.js';
import type { ServiceName } from '@haunted-ops/shared';
import { MAX_PULSES, MAX_ROOMS } from './animator.js';
import { clamp } from './math.js';
import type { Pt, RoomLayout, SceneLayout } from './layout.js';
import type { RoomVisual, SceneModel } from './model.js';
import { FONT_STACK, PALETTE, PILL_ALPHA, hexToNumber } from './palette.js';
import { FOG_BANK_MAX, FOG_WISP_MAX, GHOST_MAX, MOTE_MAX } from './particles.js';
import { CORRIDOR_STYLE, buildHouseArt, buildRoomArt, clockHands, pillRect, plaqueLayout, starField, type RoomArt } from './shapes.js';
import { SceneInitError, type Frame, type ParticleBuffer, type RoomFrame, type Surface, type SurfaceInit } from './surface.js';
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
  outlineTrim: Graphics;
  outlineAlarm: Graphics;
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
}

interface Layers {
  background: Graphics;
  house: Graphics;
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
    const layers: Layers = { background: new Graphics(), house: new Graphics(), corridors: new Container(), rooms: new Container(), texts: new Container(), ui, ring };
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
      layers.house,
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
    for (const s of starField(layout.width, layout.height)) layers.background.circle(s.x, s.y, s.r).fill({ color: num(PALETTE.ghost), alpha: s.alpha });

    const g = layers.house;
    g.clear();
    if (layout.house) {
      const art = buildHouseArt(layout.house, layout.scale);
      for (const poly of art.polys) g.poly(flat(poly.points), true).fill({ color: num(poly.fill), alpha: poly.alpha });
      g.circle(art.window.center.x, art.window.center.y, art.window.radius).fill({ color: num(art.window.fill), alpha: art.window.alpha });
      for (const line of [...art.window.bars, ...art.lines]) {
        g.poly(flat(line.points), false).stroke({ color: num(line.color), alpha: line.alpha, width: line.width, join: 'round', cap: 'round' });
      }
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
    for (const poly of art.polys) base.poly(flat(poly.points), true).fill({ color: num(poly.fill), alpha: poly.alpha });
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
    // The hunt slot: an empty container at its reserved rectangle, for `exorcist-agent`.
    const hunt = new Container();
    hunt.position.set(room.huntRect.x, room.huntRect.y);

    root.addChild(body, glow, dim, outlineTrim, outlineAlarm);
    const texts = new Container();
    texts.addChild(badgePill, badge, plate, label, incident, hunt);
    return { room, art, root, texts, body, glow, dim, outlineTrim, outlineAlarm, clock, plate, label, badge, badgePill, incident, incidentTri, incidentBang, incidentWord, hunt };
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
    view.glow.alpha = clamp(light * breath, 0, 1) * (rf.dark ? 0 : 0.85);
    view.glow.tint = mixColor(num(PALETTE.glowWarm), num(PALETTE.lightCold), rf.coolness);
    view.dim.alpha = clamp(rf.dim + (1 - clamp(light, 0, 1)) * 0.6 * (1 - rf.dim), 0, 0.95);
    const alarm = rf.coolness >= 0.55 && !rf.dark;
    view.outlineAlarm.alpha = alarm ? 0.7 : 0;
    view.outlineTrim.alpha = alarm ? 0 : rf.outlineAlpha;
    view.badge.alpha = rf.badgeAlpha;
    view.badgePill.alpha = rf.badgeAlpha;
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
