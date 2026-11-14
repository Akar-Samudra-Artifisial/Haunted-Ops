export interface FakeLabOptions {
  token: string;
  scenario?: 'error-spike' | 'fog' | 'dark-room';
  hostile?: boolean;
  unreachable?: string[];
  down?: boolean;
  extraDeploys?: Array<{ id: string; service: string; ref: string; sha: string; time: string; actor: string }>;
  /** Bearer of `POST /chaos/deploy-fix`. Without it every call is 401. */
  chaosToken?: string;
}

export interface DeployRecord {
  id: string;
  service: string;
  ref: string;
  sha: string;
  time: string;
  actor: string;
}

export interface FakeLab {
  /** One origin for both the `/lab/*` routes and the Prometheus range query. */
  url: string;
  requests: Array<{ path: string; authorized: boolean }>;
  /** The refs the lab "fetches from origin": a head and its first-parent chain with the files each commit touches. */
  refs: Map<string, { head: string; chain: Array<{ sha: string; files: string[] }> }>;
  /** Heads of `main` and the scenario branches. */
  allowedHeads: string[];
  /** Deploy records added by `deploy-fix` (also listed by `/lab/deploys`). */
  deployed: DeployRecord[];
  deployFix: { mode: 'ok' | 'unavailable' | 'never_record'; calls: Array<{ authorized: boolean; body: unknown }> };
  scenario: ScenarioInfo | undefined;
  close(): Promise<void>;
}

export interface ScenarioInfo {
  service: string;
  reason: string;
  signal: string;
  sha: string;
  deployId: string;
  ref: string;
  subject: string;
}

export function startFakeLab(opts: FakeLabOptions): Promise<FakeLab>;
