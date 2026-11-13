export interface FakeLabOptions {
  token: string;
  scenario?: 'error-spike' | 'fog' | 'dark-room';
  hostile?: boolean;
  unreachable?: string[];
  down?: boolean;
  extraDeploys?: Array<{ id: string; service: string; ref: string; sha: string; time: string; actor: string }>;
}

export interface FakeLab {
  /** One origin for both the `/lab/*` routes and the Prometheus range query. */
  url: string;
  requests: Array<{ path: string; authorized: boolean }>;
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
