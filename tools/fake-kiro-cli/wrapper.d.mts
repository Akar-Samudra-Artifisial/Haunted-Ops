export interface FakeKiroCli {
  /** The executable to give to `KIRO_CLI_PATH`. */
  path: string;
  /** Where the fake writes what it saw, when `observe` is set. */
  observePath: string;
  dir: string;
  cleanup(): void;
}

export interface FakeKiroCliOptions {
  /** A name in `fixtures/` (without suffix) or an absolute path. */
  fixture: string;
  dir?: string;
  observe?: boolean;
  lineDelayMs?: number;
}

export interface Observed {
  argv: string[];
  envNames: string[];
  cwd: string;
  agentSha: string | null;
}

export function createFakeKiroCli(opts: FakeKiroCliOptions): FakeKiroCli;
export const FAKE_KIRO_CLI: string;
