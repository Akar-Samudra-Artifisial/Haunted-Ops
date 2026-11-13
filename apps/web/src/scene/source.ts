import { useEffect, useMemo, useState } from 'react';
import type { ServiceState } from '@haunted-ops/shared';
import { demoServices, demoTime, scenarioServices } from './demo.js';
import type { DemoMode } from './params.js';

/**
 * The services of Demo mode: the scripted timeline (a new state at most once per second) or a frozen
 * scenario. With `null` it returns an empty list and starts nothing. It never calls the API.
 */
export function useDemoServices(mode: DemoMode, now: () => number = () => performance.now()): ServiceState[] {
  const frozen = useMemo(() => (mode?.kind === 'scenario' ? scenarioServices(mode.name) : null), [mode]);
  const [timeline, setTimeline] = useState<ServiceState[]>(() => demoServices(0));
  useEffect(() => {
    if (mode?.kind !== 'timeline') return;
    const start = now();
    let lastSecond = 0;
    const id = setInterval(() => {
      const t = demoTime(now() - start, mode.loop);
      const second = Math.floor(t / 1000);
      if (second === lastSecond) return;
      lastSecond = second;
      setTimeline(demoServices(t));
    }, 250);
    return () => clearInterval(id);
    // `now` is a stable clock supplied by the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
  if (mode === null) return [];
  return frozen ?? timeline;
}
