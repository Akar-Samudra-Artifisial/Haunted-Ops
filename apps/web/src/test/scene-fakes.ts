import type { ServiceState } from '@haunted-ops/shared';
import type { Env, FrameLoop } from '../scene/frame-loop.js';
import { computeLayout, type SceneLayout } from '../scene/layout.js';
import { toSceneModel, type ModelOptions, type SceneModel } from '../scene/model.js';
import type { Frame, Surface, SurfaceInit } from '../scene/surface.js';
import type { SceneInitError } from '../scene/surface.js';
import { makeService } from './arbs.js';
import { SERVICE_NAMES } from '@haunted-ops/shared';

export const NOW = Date.parse('2026-11-13T15:30:00.000Z');
export const FULL: ModelOptions = { reducedMotion: false, quality: 'full' };
export const REDUCED: ModelOptions = { reducedMotion: true, quality: 'full' };

export function house(over: Partial<Record<(typeof SERVICE_NAMES)[number], Partial<ServiceState>>> = {}): ServiceState[] {
  return SERVICE_NAMES.map((n) => makeService(n, over[n] ?? {}));
}

export function scene(
  services: ServiceState[],
  options: ModelOptions = FULL,
  viewport = { width: 1280, height: 720, dpr: 1 },
): { model: SceneModel; layout: SceneLayout } {
  return {
    model: toSceneModel(services, NOW, options),
    layout: computeLayout(services.map((s) => ({ name: s.name, grid: s.room })), viewport),
  };
}

/** Records every call; `alive` shows whether resources are currently held. */
export class FakeSurface implements Surface {
  readonly calls: string[] = [];
  alive = false;
  initCount = 0;
  destroyCount = 0;
  draws = 0;
  drawsWhileDead = 0;
  lastFrame: Frame | null = null;
  quality: 'full' | 'low' = 'full';
  failInit: SceneInitError | null = null;
  gate: Promise<void> | null = null;
  private context: ((e: 'lost' | 'restored') => void) | null = null;

  async init(_opts: SurfaceInit): Promise<void> {
    this.calls.push('init');
    this.initCount += 1;
    if (this.gate) await this.gate;
    if (this.failInit) throw this.failInit;
    this.alive = true;
  }
  applyLayout(): void {
    this.calls.push('applyLayout');
  }
  applyModel(): void {
    this.calls.push('applyModel');
  }
  draw(frame: Frame): void {
    this.draws += 1;
    if (!this.alive) this.drawsWhileDead += 1;
    this.lastFrame = frame;
  }
  resize(): void {
    this.calls.push('resize');
  }
  setQuality(q: 'full' | 'low'): void {
    this.quality = q;
    this.calls.push(`quality:${q}`);
  }
  onContext(cb: (e: 'lost' | 'restored') => void): void {
    this.context = cb;
  }
  emit(e: 'lost' | 'restored'): void {
    this.context?.(e);
  }
  destroy(): void {
    this.calls.push('destroy');
    this.destroyCount += 1;
    this.alive = false;
  }
}

export class ManualLoop implements FrameLoop {
  running = false;
  startCount = 0;
  private cb: ((dt: number, now: number) => void) | null = null;
  private now = 0;
  start(cb: (dt: number, now: number) => void): void {
    this.cb = cb;
    if (!this.running) this.startCount += 1;
    this.running = true;
  }
  stop(): void {
    this.running = false;
  }
  /** One frame of `dt` ms, only if the loop is running. Returns true if a frame ran. */
  step(dt = 16): boolean {
    if (!this.running || !this.cb) return false;
    this.now += dt;
    this.cb(dt, this.now);
    return true;
  }
}

export class FakeEnv implements Env {
  hidden = false;
  private readonly listeners = new Set<() => void>();
  get listenerCount(): number {
    return this.listeners.size;
  }
  isHidden(): boolean {
    return this.hidden;
  }
  onVisibility(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    for (const l of [...this.listeners]) l();
  }
}
