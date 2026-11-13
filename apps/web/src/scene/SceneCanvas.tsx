import { useEffect, useRef } from 'react';
import type { ServiceName } from '@haunted-ops/shared';
import { createBrowserEnv, createRafLoop } from './frame-loop.js';
import type { Quality } from './governor.js';
import type { SceneLayout } from './layout.js';
import type { SceneModel } from './model.js';
import { PixiSurface } from './pixi-surface.js';
import { createSceneRenderer, type SceneRenderer } from './renderer.js';

export interface RendererCallbacks {
  onQuality: (quality: Quality) => void;
  onContext: (event: 'lost' | 'restored') => void;
}

export interface SceneCanvasProps {
  model: SceneModel;
  layout: SceneLayout;
  selected: ServiceName | null;
  /** The renderer could not start. */
  onFailure: () => void;
  onQuality: (quality: Quality) => void;
  onContext: (event: 'lost' | 'restored') => void;
  /** Tests inject a fake renderer. */
  createRenderer?: (callbacks: RendererCallbacks) => SceneRenderer;
  /** Demo mode publishes the renderer statistics here for measurement. */
  publishStats?: boolean;
}

function defaultRenderer(callbacks: RendererCallbacks): SceneRenderer {
  return createSceneRenderer({
    surface: new PixiSurface(),
    loop: createRafLoop(),
    env: createBrowserEnv(),
    onQuality: callbacks.onQuality,
    onContext: callbacks.onContext,
  });
}

/**
 * The drawing canvas. It is the default export of the lazy chunk: the renderer, the Animator and
 * PixiJS load only when this module is imported. Created once per mount, updated from the model,
 * destroyed on unmount.
 */
export default function SceneCanvas(props: SceneCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<SceneRenderer | null>(null);
  const first = useRef({ model: props.model, layout: props.layout });
  const callbacks = useRef(props);

  useEffect(() => {
    callbacks.current = props;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Set in the cleanup: a renderer of an unmounted canvas (StrictMode mounts twice) never reports.
    let disposed = false;
    const make = callbacks.current.createRenderer ?? defaultRenderer;
    const renderer = make({
      onQuality: (q) => {
        if (!disposed) callbacks.current.onQuality(q);
      },
      onContext: (e) => {
        if (!disposed) callbacks.current.onContext(e);
      },
    });
    rendererRef.current = renderer;
    if (callbacks.current.publishStats) (window as unknown as { __hauntedScene?: unknown }).__hauntedScene = renderer.stats;
    renderer.start({ host, ...first.current }).catch(() => {
      if (!disposed) callbacks.current.onFailure();
    });
    return () => {
      disposed = true;
      renderer.destroy();
      rendererRef.current = null;
      if (callbacks.current.publishStats) delete (window as unknown as { __hauntedScene?: unknown }).__hauntedScene;
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.update(props.model);
  }, [props.model]);
  useEffect(() => {
    rendererRef.current?.resize(props.layout);
  }, [props.layout]);
  useEffect(() => {
    rendererRef.current?.select(props.selected);
  }, [props.selected]);

  return <div ref={hostRef} className="scene-canvas" role="img" aria-label={props.model.summary} />;
}
