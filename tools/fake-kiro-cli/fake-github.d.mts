export interface FakeGithubOptions {
  repo: string;
  token: string;
  canPush?: boolean;
  expires?: Date | null;
  syncRefs?: ((refs: Map<string, string>) => Promise<void> | void) | null;
  onDeleteRef?: ((name: string) => Promise<void> | void) | null;
}

export interface FakePull {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  labels: string[];
  state: 'open' | 'closed';
  merged: boolean;
  mergeSha: string | null;
  mergedBy: string | null;
  headSha: string;
  version: number;
}

export interface FakeGithub {
  /** `http://127.0.0.1:<port>`: the base URL to give the client (the real one is `https://api.github.com`). */
  url: string;
  repo: string;
  /** Branch name to commit SHA. */
  refs: Map<string, string>;
  labels: Map<string, { name: string; color?: string; description?: string }>;
  pulls: FakePull[];
  requests: Array<{ method: string; path: string; authorized: boolean }>;
  commitDates: Map<string, string>;
  merge(number: number, o: { mergeSha: string; by?: string | null }): void;
  closeUnmerged(number: number): void;
  setHead(number: number, sha: string): void;
  rateLimit(n: number, retryAfterSeconds?: number): void;
  failNext(...statuses: number[]): void;
  close(): Promise<void>;
}

export function startFakeGithub(opts: FakeGithubOptions): Promise<FakeGithub>;
