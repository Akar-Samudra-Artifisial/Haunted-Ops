import { Component, Suspense, use, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import type { ServiceName, ServiceState } from '@haunted-ops/shared';
import type { Quality } from '../scene/governor.js';
import { useElementSize } from '../scene/hooks.js';
import { computeLayout, mountHeight } from '../scene/layout.js';
import type { Pt, RoomLayout } from '../scene/layout.js';
import type { SceneModel } from '../scene/model.js';
import { RoomButtons } from '../scene/RoomButtons.js';
import type { SceneCanvasProps } from '../scene/SceneCanvas.js';

export type CanvasModule = { default: ComponentType<SceneCanvasProps> };
export type CanvasLoader = () => Promise<CanvasModule>;

/** The scene chunk is loaded here and nowhere else, so PixiJS stays out of the entry chunk. */
export const defaultLoadCanvas: CanvasLoader = () => import('../scene/SceneCanvas.js');

const loads = new WeakMap<CanvasLoader, Promise<CanvasModule>>();
/** One load per loader, so a rerender never loads the chunk twice. */
function loadOnce(loader: CanvasLoader): Promise<CanvasModule> {
  let promise = loads.get(loader);
  if (!promise) {
    promise = loader();
    loads.set(loader, promise);
  }
  return promise;
}

/** Suspends until the scene chunk is there, then draws it. A failed load goes to the error boundary. */
function LoadedCanvas({ loader, ...props }: SceneCanvasProps & { loader: CanvasLoader }) {
  const { default: Canvas } = use(loadOnce(loader));
  return <Canvas {...props} />;
}

export const FALLBACK_TEXT = 'The house view is not available on this device. The table shows the same information.';

/** Shown instead of the canvas when the scene cannot run. The table stays the full view. */
export function SceneFallback() {
  return (
    <p className="scene-fallback">
      {FALLBACK_TEXT}
    </p>
  );
}

class CanvasBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(): void {
    this.props.onError();
  }
  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export interface SceneMountProps {
  services: readonly ServiceState[];
  model: SceneModel;
  selected: ServiceName | null;
  onSelect?: (name: ServiceName | null) => void;
  onQuality?: (quality: Quality) => void;
  /** Tests and Demo mode can replace how the scene chunk loads or what it draws with. */
  loadCanvas?: CanvasLoader;
  createRenderer?: SceneCanvasProps['createRenderer'];
  publishStats?: boolean;
  /** Said once through the page's one announcer when the fallback appears. */
  onNotice?: (text: string) => void;
}

/**
 * The place of the house scene. It renders at once with a text placeholder, loads the scene chunk
 * with a dynamic import, and never stays empty: when the scene cannot run it shows a message.
 */
export function SceneMount(props: SceneMountProps) {
  const { services, model, selected, loadCanvas, createRenderer, publishStats } = props;
  const ref = useRef<HTMLElement>(null);
  const size = useElementSize(ref);
  const [failed, setFailed] = useState(false);
  const [contextLost, setContextLost] = useState(false);
  // The outline of a room from the scene chunk (`roomOutline`): `null` until the scene runs, and the buttons keep their CSS focus outline; then the
  // hit shape of a room button is that outline and the scene draws the ring of keyboard focus.
  const [outline, setOutline] = useState<((room: RoomLayout) => Pt[]) | null>(null);
  const [focused, setFocused] = useState<ServiceName | null>(null);

  const rooms = useMemo(() => services.map((s) => ({ name: s.name, grid: s.room })), [services]);
  const aspect = useMemo(() => computeLayout(rooms, { width: 1000, height: 1000, dpr: 1 }).aspect, [rooms]);
  const layout = useMemo(
    () => (size.width > 0 && size.height > 0 ? computeLayout(rooms, { width: size.width, height: size.height, dpr: typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1 }) : null),
    [rooms, size.width, size.height],
  );
  const height = size.width > 0 ? mountHeight(size.width, aspect, typeof window === 'undefined' ? 800 : window.innerHeight) : undefined;

  const showsFallback = failed || contextLost;
  const { onNotice } = props;
  useEffect(() => {
    if (showsFallback) onNotice?.(FALLBACK_TEXT);
  }, [showsFallback, onNotice]);
  const onFailure = useCallback(() => setFailed(true), []);
  const onContext = useCallback((event: 'lost' | 'restored') => setContextLost(event === 'lost'), []);
  const onOutline = useCallback((fn: (room: RoomLayout) => Pt[]) => setOutline(() => fn), []);
  const onQuality = props.onQuality ?? (() => undefined);
  const onSelect = props.onSelect ?? (() => undefined);

  return (
    <section id="scene-mount" className="scene-mount" aria-label="House scene" ref={ref} style={height === undefined ? undefined : { height }}>
      {failed ? (
        <SceneFallback />
      ) : (
        <>
          <Suspense fallback={<p className="scene-placeholder">{model.summary}</p>}>
            <CanvasBoundary onError={onFailure}>
              {layout ? (
                <div className="scene-stage" hidden={contextLost}>
                  <LoadedCanvas
                    loader={loadCanvas ?? defaultLoadCanvas}
                    model={model}
                    layout={layout}
                    selected={selected}
                    focused={focused}
                    onFailure={onFailure}
                    onQuality={onQuality}
                    onContext={onContext}
                    onOutline={onOutline}
                    createRenderer={createRenderer}
                    publishStats={publishStats}
                  />
                </div>
              ) : (
                <p className="scene-placeholder">{model.summary}</p>
              )}
            </CanvasBoundary>
          </Suspense>
          {layout && !contextLost ? <RoomButtons layout={layout} model={model} selected={selected} onSelect={onSelect} outline={contextLost ? null : outline} onFocusVisible={setFocused} /> : null}
          {contextLost ? <SceneFallback /> : null}
        </>
      )}
    </section>
  );
}
