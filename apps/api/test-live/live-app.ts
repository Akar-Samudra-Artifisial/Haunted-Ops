import type { ProposalView } from '@haunted-ops/shared';
import type { FixOverrides } from '../src/app.module.js';
import { parseFixConfig, type FixConfig } from '../src/fix/fix-config.js';
import { checkFixStartup } from '../src/fix/fix-startup.js';
import { GitClient } from '../src/fix/git-client.js';
import { GithubClient } from '../src/fix/github-client.js';
import { HttpChaosClient } from '../src/fix/lab-deploy-client.js';
import { ProposalRunner } from '../src/fix/proposal-runner.js';
import { parseHuntConfig, type HuntConfig } from '../src/hunts/hunt-config.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { seedServices } from '../src/prisma/seed.js';
import { startServer, testConfig, type TestServer } from '../test/support/http.js';

/**
 * The app of the opt-in live test (`fix.live.ts`) and of its parity test (`test/fix.live-parity.int.test.ts`), built by
 * one function so that the live wiring is exercised without Credits. It does what `main.ts` does for the fix flow:
 * the startup check (token, repository, labels, chaos token) and `ProposalRunner.start()` (the working folder, the
 * lab dependency tree and the test baseline).
 */
export type LiveEnv = Readonly<Record<string, string | undefined>>;

/**
 * The only two names the fixer takes from the API's environment. The live test is the exception to the guard of
 * `ProposalRunner` (a run under Vitest with no `parentEnv` throws, so the real home is never a silent fallback in unit
 * and integration tests): it names the home of the logged-in `kiro-cli` on purpose.
 */
export const liveParentEnv = (env: LiveEnv): Record<string, string | undefined> => ({ HOME: env.HOME, LANG: env.LANG });

/** The fix overrides of the live app: the caller's seams, with the polling timer off and `parentEnv` always set. */
export const liveFixOverrides = (env: LiveEnv, extra: FixOverrides = {}): FixOverrides => ({ ...extra, poll: false, parentEnv: liveParentEnv(env) });

export interface LiveApp {
  server: TestServer;
  huntConfig: HuntConfig;
  fixCfg: FixConfig;
  runner: ProposalRunner;
}

export interface LiveAppOptions {
  /** Extra settings of the app config (`PROMETHEUS_URL` is taken from `env`). */
  config?: Record<string, string>;
  /** Seams for tests with fakes (a fake GitHub URL, a local git remote, timings). Never `parentEnv` or `poll`. */
  fixOverrides?: FixOverrides;
}

export async function startLiveApp(env: LiveEnv, o: LiveAppOptions = {}): Promise<LiveApp> {
  const huntConfig = parseHuntConfig({ ...env, HUNTS_ENABLED: 'true' });
  const fixCfg = parseFixConfig({ ...env, FIX_ENABLED: 'true' }, huntConfig);
  const server = await startServer({
    config: testConfig({ PROMETHEUS_URL: env.PROMETHEUS_URL ?? 'http://127.0.0.1:9090', ...o.config }),
    huntConfig,
    fixConfig: fixCfg,
    fixOverrides: liveFixOverrides(env, o.fixOverrides),
  });
  const prisma = server.app.get(PrismaService).client;
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Proposal", "Evidence", "HuntStep", "Hunt", "Incident", "Signal", "Service" RESTART IDENTITY CASCADE');
  await seedServices(prisma);
  // As `main.ts`: the checks of the setup, then the runner (its folder, the lab dependency tree, the test baseline).
  await checkFixStartup(fixCfg, {
    github: server.app.get(GithubClient),
    gitVersion: () => server.app.get(GitClient).version(),
    log: (level, msg, fields) => server.logs.push(`${JSON.stringify({ level, msg, ...fields })}\n`),
    chaos: new HttpChaosClient(fixCfg.chaosUrl, fixCfg.chaosToken ?? ''),
    pnpmPath: fixCfg.pnpmPath ?? null,
  });
  const runner = server.app.get(ProposalRunner);
  await runner.start();
  return { server, huntConfig, fixCfg, runner };
}

/** The log lines that say why a Proposal failed. */
export const LOG_PATTERN = /proposal|fixer|check run|test baseline|lab deps/i;
const MAX_LOG_LINES = 40;

/**
 * One block for the output of a failed live run: the fields of the Proposal that say why, then the last 40 API log
 * lines about it (the logger already redacted them). No token and no path of the Proposal's own text is added.
 */
export function failureBlock(view: ProposalView | null, logs: readonly string[]): string {
  const head =
    view === null
      ? ['[fix-live] no proposal view']
      : [
          '[fix-live] proposal that did not open:',
          `[fix-live] status=${view.status} kind=${view.kind ?? 'none'} failReason=${view.failReason ?? 'none'} aiFailReason=${view.aiFailReason ?? 'none'}`,
          `[fix-live] aiFailDetail=${view.aiFailDetail ?? 'none'}`,
          `[fix-live] checks=${view.checks.map((c) => `${c.name}:${c.ok ? 'ok' : 'FAIL'}${c.skipped === true ? '(skipped)' : ''}`).join(',') || 'none'}`,
        ];
  const lines = logs
    .map((l) => l.trimEnd())
    .filter((l) => LOG_PATTERN.test(l))
    .slice(-MAX_LOG_LINES)
    .map((l) => `[fix-live] log ${l}`);
  return [...head, ...lines].join('\n');
}

/**
 * Polls `GET /api/proposals/:id` until the status leaves `drafting` or the deadline passes. `onChange` is called once
 * per status change (the first view included), so a long wait shows where it is.
 */
export async function waitForProposal(
  baseUrl: string,
  proposalId: string,
  deadlineMs: number,
  onChange: (status: string) => void,
  o: { fetchFn?: typeof fetch; pollMs?: number } = {},
): Promise<ProposalView | null> {
  const fetchFn = o.fetchFn ?? fetch;
  let view: ProposalView | null = null;
  let last = '';
  while (Date.now() < deadlineMs) {
    const res = await fetchFn(`${baseUrl}/api/proposals/${proposalId}`);
    view = (await res.json()) as ProposalView;
    if (view.status !== last) {
      last = view.status;
      onChange(last);
    }
    if (view.status !== 'drafting') break;
    await new Promise((r) => setTimeout(r, o.pollMs ?? 2000));
  }
  return view;
}
