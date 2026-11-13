import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

function mediaQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_QUERY) : null;
}

function subscribeReduced(onChange: () => void): () => void {
  const mq = mediaQuery();
  if (!mq) return () => undefined;
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

/** `prefers-reduced-motion: reduce`, read at start and followed when it changes. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, () => mediaQuery()?.matches ?? false, () => false);
}

/** The current time in milliseconds, refreshed every `intervalMs` (the clock on the wall needs a minute). */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * Size of an element, from a ResizeObserver. Changes are coalesced to one update per animation frame,
 * and a size of 0 is reported as it is (the caller waits for a real size).
 */
export function useElementSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let frame: number | null = null;
    let latest: Size = { width: 0, height: 0 };
    const flush = (): void => {
      frame = null;
      setSize((prev) => (prev.width === latest.width && prev.height === latest.height ? prev : latest));
    };
    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (!box) return;
      latest = { width: Math.round(box.width), height: Math.round(box.height) };
      if (frame === null) frame = requestAnimationFrame(flush);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [ref]);
  return size;
}
