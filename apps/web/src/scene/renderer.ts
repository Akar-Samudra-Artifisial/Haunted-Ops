import type { ServiceName } from '@haunted-ops/shared';
import { createAnimator, MAX_STEP_MS, visibleParticles, type Animator } from './animator.js';
import type { Env, FrameLoop } from './frame-loop.js';
import { PerfGovernor, type Quality } from './governor.js';
import type { SceneLayout } from './layout.js';
import type { SceneModel } from './model.js';
import type { Surface } from './surface.js';

export interface RendererStats {
  /** Smoothed time between frames in milliseconds. */
  frameMs: number;
  particles: number;
  quality: Quality;
  frames: number;
}

export interface SceneRenderer {
  start(initial: { host: HTMLElement; model: SceneModel; layout: SceneLayout }): Promise<void>;
  update(model: SceneModel): void;
  resize(layout: SceneLayout): void;
  select(name: ServiceName | null): void;
  /** Idempotent. Safe before `start` has finished. */
  destroy(): void;
  readonly stats: RendererStats;
}

export interface RendererDeps {
  surface: Surface;
  loop: FrameLoop;
  env: Env;
  animator?: Animator;
  governor?: PerfGovernor;
  onQuality?: (quality: Quality) => void;
  onContext?: (event: 'lost' | 'restored') => void;
}

/**
 * Owns the lifecycle: the Surface, the frame loop and the subscriptions. All drawing decisions
 * come from the Animator; this only decides when to run and when to stop.
 */
export function createSceneRenderer(deps: RendererDeps): SceneRenderer {
  const { surface, loop, env } = deps;
  const animator = deps.animator ?? createAnimator();
  const governor = deps.governor ?? new PerfGovernor();
  const stats: RendererStats = { frameMs: 16.7, particles: 0, quality: 'full', frames: 0 };
  const unsubscribes: Array<() => void> = [];
  let destroyed = false;
  let started = false;
  let starting = false;
  let model: SceneModel | null = null;
  let layout: SceneLayout | null = null;
  let timeMs = 0;

  const kick = (): void => {
    if (destroyed || !started || env.isHidden()) return;
    if (!loop.running) loop.start(tick);
  };

  function tick(dtMs: number): void {
    if (destroyed) return;
    const dt = Math.min(Math.max(dtMs, 0), MAX_STEP_MS);
    timeMs += dt;
    const frame = animator.step(dt, timeMs);
    surface.draw(frame);
    stats.frames += 1;
    stats.frameMs = stats.frameMs * 0.9 + dt * 0.1;
    stats.particles = visibleParticles(frame);
    const quality = governor.push(dt);
    if (quality !== stats.quality) {
      stats.quality = quality;
      surface.setQuality(quality);
      deps.onQuality?.(quality);
    }
    // Nothing moves any more: stop drawing identical frames until something changes.
    if (!frame.moving) loop.stop();
  }

  return {
    async start(initial) {
      // One Surface per renderer: a second call is ignored.
      if (destroyed || starting) return;
      starting = true;
      model = initial.model;
      layout = initial.layout;
      try {
        await surface.init({
          host: initial.host,
          width: initial.layout.width,
          height: initial.layout.height,
          dpr: initial.layout.dpr,
          quality: stats.quality,
        });
      } catch (err) {
        surface.destroy();
        // A destroyed renderer (StrictMode mounts twice, or the mount went away) reports nothing.
        if (destroyed) return;
        throw err;
      }
      if (destroyed) {
        // destroy() ran while the Surface was starting: release what init made.
        surface.destroy();
        return;
      }
      surface.onContext((event) => {
        if (destroyed) return;
        deps.onContext?.(event);
        if (event === 'lost') loop.stop();
        else kick();
      });
      started = true;
      surface.applyLayout(layout);
      surface.applyModel(model);
      animator.setLayout(layout);
      animator.setModel(model);
      unsubscribes.push(
        env.onVisibility(() => {
          if (destroyed) return;
          if (env.isHidden()) loop.stop();
          else kick();
        }),
      );
      kick();
    },
    update(next) {
      if (destroyed) return;
      model = next;
      if (!started) return;
      surface.applyModel(next);
      animator.setModel(next);
      kick();
    },
    resize(next) {
      if (destroyed) return;
      layout = next;
      if (!started) return;
      surface.resize(next.width, next.height, next.dpr);
      surface.applyLayout(next);
      animator.setLayout(next);
      kick();
    },
    select(name) {
      if (destroyed) return;
      animator.select(name);
      kick();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      loop.stop();
      for (const off of unsubscribes.splice(0)) off();
      surface.destroy();
    },
    stats,
  };
}
