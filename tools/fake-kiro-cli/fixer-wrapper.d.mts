export interface FakeKiroFixer {
  /** The executable to give as the `kiro-cli` of the fix flow. */
  path: string;
  /** Where the fake writes what it saw, when `observe` is set. */
  observePath: string;
  dir: string;
  cleanup(): void;
}
export interface FakeKiroFixerOptions {
  /** A name in `fixtures/fixer/` (without suffix) or an absolute path. */
  fixture: string;
  dir?: string;
  observe?: boolean;
}
export interface FixerObserved {
  argv: string[];
  envNames: string[];
  cwd: string;
  agentSha: string | null;
  files: string[];
  hasGit: boolean;
}
export function createFakeKiroFixer(opts: FakeKiroFixerOptions): FakeKiroFixer;
export const FAKE_KIRO_FIXER: string;
