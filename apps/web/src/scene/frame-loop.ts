/** Calls back once per frame while running. Injected, so tests step it by hand. */
export interface FrameLoop {
  /** Starts, or replaces the callback when already running. `dtMs` is the time since the last frame. */
  start(cb: (dtMs: number, nowMs: number) => void): void;
  stop(): void;
  readonly running: boolean;
}

/** Page visibility, injected for the same reason. */
export interface Env {
  isHidden(): boolean;
  /** Returns the unsubscribe function. */
  onVisibility(cb: () => void): () => void;
}

/** Frames closer together than this are skipped, which caps the rate at about 60 fps. */
export const MIN_FRAME_MS = 15;

export interface RafDeps {
  raf?: (cb: (t: number) => void) => number;
  caf?: (id: number) => void;
  now?: () => number;
}

/** requestAnimationFrame loop with a 60 fps cap. */
export function createRafLoop(deps: RafDeps = {}): FrameLoop {
  const raf = deps.raf ?? ((cb: (t: number) => void) => requestAnimationFrame(cb));
  const caf = deps.caf ?? ((id: number) => cancelAnimationFrame(id));
  const now = deps.now ?? (() => performance.now());
  let id: number | null = null;
  let running = false;
  let callback: ((dtMs: number, nowMs: number) => void) | null = null;
  let last = 0;

  const tick = (t: number): void => {
    if (!running) return;
    id = raf(tick);
    const dt = t - last;
    if (dt < MIN_FRAME_MS) return;
    last = t;
    callback?.(dt, t);
  };

  return {
    start(cb) {
      callback = cb;
      if (running) return;
      running = true;
      last = now();
      id = raf(tick);
    },
    stop() {
      running = false;
      if (id !== null) caf(id);
      id = null;
    },
    get running() {
      return running;
    },
  };
}

/** The browser's visibility events. */
export function createBrowserEnv(doc: Document = document): Env {
  return {
    isHidden: () => doc.hidden,
    onVisibility(cb) {
      doc.addEventListener('visibilitychange', cb);
      return () => doc.removeEventListener('visibilitychange', cb);
    },
  };
}
