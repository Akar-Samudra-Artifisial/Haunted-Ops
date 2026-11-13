export const DEMO_SCENARIOS = [
  'calm',
  'payments-haunted',
  'payments-possessed',
  'orders-fog',
  'ledger-dark',
  'all-haunted',
  'payments-hunting',
  'payments-sealed',
  'payments-fizzled',
] as const;
export type DemoScenarioName = (typeof DEMO_SCENARIOS)[number];

export type DemoMode = { kind: 'timeline'; loop: boolean } | { kind: 'scenario'; name: DemoScenarioName } | null;

export interface DemoEnv {
  PROD: boolean;
  VITE_DEMO_MODE?: string | undefined;
}

export function isScenarioName(value: string): value is DemoScenarioName {
  return (DEMO_SCENARIOS as readonly string[]).includes(value);
}

/**
 * `?demo=1` runs the scripted timeline (`&loop=1` restarts it), `?demo=<scenario>` freezes one state.
 * Anything else is ignored. A production build ignores the parameter unless `VITE_DEMO_MODE` is `true`.
 */
export function parseDemoParam(search: string, env: DemoEnv): DemoMode {
  if (env.PROD && env.VITE_DEMO_MODE !== 'true') return null;
  const params = new URLSearchParams(search);
  const demo = params.get('demo');
  if (demo === null) return null;
  if (demo === '1') return { kind: 'timeline', loop: params.get('loop') === '1' };
  if (isScenarioName(demo)) return { kind: 'scenario', name: demo };
  return null;
}
