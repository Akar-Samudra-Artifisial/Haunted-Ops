import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateProposalView, type ProposalView } from '@haunted-ops/shared';
import { startFakeGithub, type FakeGithub } from '../../../tools/fake-kiro-cli/fake-github.mjs';
import { startFakeLab, type FakeLab } from '../../../tools/fake-kiro-cli/fake-lab.mjs';
import { createFakeKiroFixer, type FakeKiroFixer } from '../../../tools/fake-kiro-cli/fixer-wrapper.mjs';
import { PrismaHuntStore } from '../src/hunts/hunt-store.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { failureBlock, liveFixOverrides, liveParentEnv, startLiveApp, waitForProposal, type LiveApp } from '../test-live/live-app.js';
import { describeDb } from './db.js';
import { DUMMY_GITHUB_TOKEN } from './support/fix.js';
import { REPO, WEB_ORIGIN } from './support/fix-harness.js';
import { deleteRefIn, gitIn, makeLabRepo, syncRefsFrom, type LabRepo } from './support/lab-repo.js';

/**
 * The live test without Credits (task 22.6). The app is built by the helper of the opt-in live test (`test-live/live-app.ts`,
 * with `parentEnv`, the startup check and `ProposalRunner.start()`), against a fake GitHub, a fake lab, a local git
 * remote and a fake kiro-cli that replays, one run each, every stream of `fixtures/fixer-streams/` that edits `refunds.ts`
 * and applies the edit in the work folder. Each run must open an `ai_patch` pull request with the checks passing; the
 * stream that is refused by design ends as a revert with its reason. The recorded login folder of the parent home must
 * keep its mode over all runs.
 */
const LAB_TOKEN = 'lab-read-token-0123456789-abcdef';
const ADMIN_TOKEN = 'admin-token-0123456789-abcdefgh';
const CHAOS_TOKEN = 'chaos-token-0123456789-abcdefghij';
const STREAMS = new URL('./fixtures/fixer-streams/', import.meta.url);

/** The fixtures that edit `refunds.ts`, and the ones refused by design with the text their reason must have. */
const EDITING = ['edit-command', 'read-directory', 'str-replace-all', 'update-new-title', 'update-no-meta', 'write-create', 'write-insert-append', 'write-insert-line'];
const REFUSED: Record<string, RegExp> = { 'read-image': /^unknown_args: fs_read arguments not understood: image_read kind=read keys=\[operations\]$/ };

const REFUNDS = `type RefundTerms = { days: number; fee: number };
export const DEFAULT_TERMS: RefundTerms = { days: 14, fee: 0 };
const known = new Map<string, RefundTerms>([['o-1', { days: 30, fee: 2 }]]);
function findRefund(orderId: string): RefundTerms | undefined {
  return known.get(orderId);
}
export function refundTerms(orderId: string): RefundTerms {
  const refund = findRefund(orderId) as RefundTerms;
  return refund;
}
`;
const CHARGE_TEST_PASSING = `import test from 'node:test';
import assert from 'node:assert/strict';
import { chargeAmount } from '../src/charge.js';
test('an amount is charged in cents', () => {
  assert.equal(chargeAmount({ amount: 1.5 }), 150);
});
`;
const REFUNDS_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { refundTerms } from '../src/refunds.ts';
test('a known order has its terms', () => {
  assert.equal(refundTerms('o-1').days, 30);
});
`;

/** The streams that write to `refunds.ts` (a call with a write-shaped input), by name. */
function editingStreams(): string[] {
  return readdirSync(STREAMS)
    .filter((f) => f.endsWith('.stream.jsonl'))
    .filter((f) => {
      const lines = readFileSync(new URL(f, STREAMS), 'utf8').split('\n').filter((l) => l !== '');
      return lines.some((l) => {
        const u = (JSON.parse(l) as { data?: { update?: { sessionUpdate?: string; rawInput?: Record<string, unknown> } } }).data?.update;
        const input = u?.rawInput;
        return u?.sessionUpdate === 'tool_call' && input !== undefined && input.path === 'services/payments/src/refunds.ts' && (['create', 'strReplace', 'insert'].includes(String(input.command)) || 'text' in input || 'oldStr' in input);
      });
    })
    .map((f) => f.replace('.stream.jsonl', ''))
    .sort();
}

describe('the live helper (no database)', () => {
  it('always gives the fixer a parentEnv of HOME and LANG only: the first live run failed for the lack of it', () => {
    const env = { HOME: '/tmp/fake-parent-home', LANG: 'en_US.UTF-8', GITHUB_TOKEN: DUMMY_GITHUB_TOKEN, CHAOS_TOKEN, PATH: '/usr/bin' };
    expect(liveParentEnv(env)).toEqual({ HOME: '/tmp/fake-parent-home', LANG: 'en_US.UTF-8' });
    const overrides = liveFixOverrides(env);
    expect(overrides.parentEnv).toEqual({ HOME: '/tmp/fake-parent-home', LANG: 'en_US.UTF-8' });
    expect(overrides.poll).toBe(false);
    // A seam of a test is kept, but it cannot remove the parentEnv or turn the polling timer on.
    const merged = liveFixOverrides(env, { githubBaseUrl: 'http://127.0.0.1:1', parentEnv: undefined, poll: true });
    expect(merged).toMatchObject({ githubBaseUrl: 'http://127.0.0.1:1', poll: false, parentEnv: { HOME: '/tmp/fake-parent-home', LANG: 'en_US.UTF-8' } });
    expect(JSON.stringify(merged.parentEnv)).not.toContain(DUMMY_GITHUB_TOKEN);
    expect(JSON.stringify(merged.parentEnv)).not.toContain(CHAOS_TOKEN);
  });

  it('prints a failure block with the status, reasons, detail, checks and the last 40 matching log lines', () => {
    const view = {
      status: 'failed',
      kind: null,
      failReason: 'internal',
      aiFailReason: 'agent_failed',
      aiFailDetail: 'fixer_not_started: Error: parentEnv is required in tests',
      checks: [{ name: 'scope', ok: true }, { name: 'tests', ok: false }],
    } as unknown as ProposalView;
    const logs = [...Array.from({ length: 60 }, (_, i) => `{"msg":"proposal ${i}"}\n`), '{"msg":"http request"}\n', '{"msg":"fixer halted"}\n', '{"msg":"lab deps failed"}\n'];
    const text = failureBlock(view, logs);
    const lines = text.split('\n');
    expect(lines[0]).toBe('[fix-live] proposal that did not open:');
    expect(lines[1]).toBe('[fix-live] status=failed kind=none failReason=internal aiFailReason=agent_failed');
    expect(lines[2]).toBe('[fix-live] aiFailDetail=fixer_not_started: Error: parentEnv is required in tests');
    expect(lines[3]).toBe('[fix-live] checks=scope:ok,tests:FAIL');
    const logLines = lines.slice(4);
    expect(logLines).toHaveLength(40);
    expect(logLines.at(-1)).toBe('[fix-live] log {"msg":"lab deps failed"}');
    expect(text).not.toContain('http request');
    expect(failureBlock(null, [])).toBe('[fix-live] no proposal view');
  });

  it('prints one progress line per status change while it waits', async () => {
    const answers = ['drafting', 'drafting', 'drafting', 'open'];
    let n = 0;
    const fetchFn = (async () => new Response(JSON.stringify({ status: answers[Math.min(n++, answers.length - 1)] }))) as unknown as typeof fetch;
    const seen: string[] = [];
    const view = await waitForProposal('http://x.invalid', 'p1', Date.now() + 5000, (s) => seen.push(s), { fetchFn, pollMs: 1 });
    expect(seen).toEqual(['drafting', 'open']);
    expect(view?.status).toBe('open');
    // The deadline ends the wait with the last view.
    const never = (async () => new Response(JSON.stringify({ status: 'drafting' }))) as unknown as typeof fetch;
    const late = await waitForProposal('http://x.invalid', 'p1', Date.now() + 30, () => undefined, { fetchFn: never, pollMs: 5 });
    expect(late?.status).toBe('drafting');
  });

  it('keeps the schema-derived and the recorded streams that edit refunds.ts in the list this test replays', () => {
    expect(editingStreams()).toEqual(EDITING);
    for (const name of Object.keys(REFUSED)) expect(readdirSync(STREAMS)).toContain(`${name}.stream.jsonl`);
  });
});

describeDb('live parity: the app of the live test, a fake kiro-cli that replays the streams, fake GitHub and fake lab', () => {
  let root: string;
  let lab: LabRepo;
  let github: FakeGithub;
  let fakeLab: FakeLab;
  let cli: FakeKiroFixer;
  let app: LiveApp;
  let state: string;
  let stateFile: string;
  const streamFile = (): string => join(root, 'stream-path');
  const modes = (): string => [state, stateFile].map((p) => (statSync(p).mode & 0o777).toString(8)).join(' ');

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'fix-parity-'));
    lab = makeLabRepo();
    // The deployed commit also holds `refunds.ts` and a test that imports it, as the real Lab does.
    gitIn(lab.work, ['checkout', '--quiet', 'scenario/error-spike']);
    mkdirSync(join(lab.work, 'services', 'payments', 'test'), { recursive: true });
    writeFileSync(join(lab.work, 'services', 'payments', 'src', 'refunds.ts'), REFUNDS);
    writeFileSync(join(lab.work, 'services', 'payments', 'test', 'refunds.test.js'), REFUNDS_TEST);
    // The bug of this lab is in `refunds.ts` (the streams edit it), so the tests of the deployed commit all pass.
    writeFileSync(join(lab.work, 'services', 'payments', 'test', 'charge.test.js'), CHARGE_TEST_PASSING);
    gitIn(lab.work, ['add', '-A']);
    gitIn(lab.work, ['commit', '--quiet', '-m', 'add refund terms']);
    lab.base = gitIn(lab.work, ['rev-parse', 'HEAD']);
    gitIn(lab.work, ['push', '--quiet', lab.remote, 'scenario/error-spike']);
    github = await startFakeGithub({ repo: REPO, token: DUMMY_GITHUB_TOKEN, syncRefs: syncRefsFrom(lab.remote), onDeleteRef: deleteRefIn(lab.remote) });
    fakeLab = await startFakeLab({
      token: LAB_TOKEN,
      chaosToken: CHAOS_TOKEN,
      extraDeploys: [{ id: 'd-50', service: 'payments', ref: 'scenario/error-spike', sha: lab.base, time: new Date(Date.now() + 1000).toISOString(), actor: 'chaos' }],
    });
    fakeLab.allowedHeads.push(lab.main, lab.base, lab.other);
    // The login state of the parent home that the real kiro-cli keeps: its modes must never change.
    const home = join(root, 'home');
    state = join(home, 'Library', 'Application Support', 'kiro-cli');
    mkdirSync(state, { recursive: true });
    chmodSync(state, 0o700);
    stateFile = join(state, 'data.sqlite3');
    writeFileSync(stateFile, 'login state', { mode: 0o600 });
    chmodSync(stateFile, 0o600);
    // One fake kiro-cli that replays the stream named in a file, so one app runs every stream.
    writeFileSync(streamFile(), 'none');
    mkdirSync(join(root, 'cli'));
    cli = createFakeKiroFixer({ fixture: 'fixer-good', dir: join(root, 'cli'), streamFile: streamFile() });
    mkdirSync(join(root, 'hunts'));
    app = await startLiveApp(
      {
        PATH: process.env.PATH,
        HOME: home,
        LANG: 'en_US.UTF-8',
        GITHUB_TOKEN: DUMMY_GITHUB_TOKEN,
        LAB_GITHUB_REPO: REPO,
        CHAOS_URL: fakeLab.url,
        CHAOS_TOKEN,
        WEB_ORIGIN,
        LAB_URL: fakeLab.url,
        LAB_READ_TOKEN: LAB_TOKEN,
        HUNT_ADMIN_TOKEN: ADMIN_TOKEN,
        KIRO_CLI_PATH: cli.path,
        PROMETHEUS_URL: fakeLab.url,
        HUNT_WORKDIR: join(root, 'hunts'),
        HUNT_COOLDOWN_MS: '0',
        FIX_WORKDIR: join(root, 'fix'),
        FIX_TIMEOUT_MS: '30000',
        FIX_TEST_TIMEOUT_MS: '30000',
      },
      {
        fixOverrides: {
          githubBaseUrl: github.url,
          gitRemoteUrl: () => `file://${lab.remote}`,
          allowFileProtocol: true,
          timings: { confirmMs: 100, confirmEveryMs: 10, deployRetries: 2, retryBackoffMs: 1 },
        },
      },
    );
  }, 120_000);

  afterAll(async () => {
    await app?.server.close();
    await fakeLab?.close();
    await github?.close();
    cli?.cleanup();
    lab?.cleanup();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  /** A succeeded Hunt of `payments` that names the culprit commit, as the live test writes it. */
  async function hunt(): Promise<string> {
    const prisma = app.server.app.get(PrismaService).client;
    const hunts = new PrismaHuntStore(prisma);
    const service = await prisma.service.findFirstOrThrow({ where: { name: 'payments' } });
    const incident = await prisma.incident.create({ data: { serviceId: service.id, peakLevel: 3, openedAt: new Date(Date.now() - 600_000), closedAt: new Date(Date.now() - 1_000) } });
    const created = await hunts.create({ incidentId: incident.id, serviceId: service.id, trigger: 'operator', model: app.fixCfg.model });
    await hunts.markRunning(created.id, new Date(Date.now() - 60_000));
    await hunts.addEvidence(created.id, { order: 1, kind: 'deploy', ref: 'deploy:d-7', detail: 'd-7 payments' });
    await hunts.addEvidence(created.id, { order: 2, kind: 'commit', ref: `commit:${lab.culprit}`, detail: 'simplify charge lookup' });
    await hunts.finish(created.id, {
      status: 'succeeded',
      reason: 'diagnosed',
      invalidCheck: null,
      credits: 0.9,
      toolCalls: 12,
      durationMs: 5000,
      finishedAt: new Date(),
      diagnosis: { culpritDeploy: 'd-7', culpritSha: lab.culprit, culpritService: 'payments', summary: 'The guard on a missing order was removed.', fixHint: 'Restore the guard.', cited: ['deploy:d-7', `commit:${lab.culprit}`] },
    });
    return created.id;
  }

  /** One run: the fake replays `name`, the runner drafts, the view is read over the route. */
  async function runStream(name: string): Promise<{ view: ProposalView; huntId: string }> {
    writeFileSync(streamFile(), new URL(`${name}.stream.jsonl`, STREAMS).pathname);
    const huntId = await hunt();
    const started = await app.runner.request(huntId, 'operator');
    if (started.kind !== 'started') throw new Error(`not started: ${started.kind}`);
    await app.runner.idle();
    const view = await waitForProposal(app.server.url, started.proposalId, Date.now() + 20_000, () => undefined);
    if (view === null || view.status === 'drafting') throw new Error('the proposal never left drafting');
    return { view, huntId };
  }

  it('opens an ai_patch pull request with the checks passing for every stream that edits refunds.ts', async () => {
    const before = modes();
    expect(before).toBe('700 600');
    for (const name of EDITING) {
      const { view, huntId } = await runStream(name);
      // On a failure, the block of the live test says why.
      if (view.status !== 'open' || view.kind !== 'ai_patch') process.stderr.write(`${name}\n${failureBlock(view, app.server.logs)}\n`);
      expect(validateProposalView(view).ok, name).toBe(true);
      expect(view, name).toMatchObject({ status: 'open', kind: 'ai_patch', aiFailReason: null, aiFailDetail: null });
      expect(view.checks.filter((c) => c.name !== 'touches_culprit_files').every((c) => c.ok), name).toBe(true);
      expect(view.checks.map((c) => c.name), name).toEqual(expect.arrayContaining(['non_empty', 'scope', 'forbidden_file', 'size', 'syntax', 'tests']));
      expect(github.pulls.at(-1), name).toMatchObject({ head: `exorcist/${huntId}`, labels: ['exorcist', 'ai_patch'], state: 'open' });
      // The pushed fix is the edit of the stream: `refunds.ts` changed, and only it.
      gitIn(lab.work, ['fetch', '--quiet', lab.remote, `+refs/heads/exorcist/${huntId}:refs/heads/exorcist/${huntId}`]);
      expect(gitIn(lab.work, ['diff', '--name-only', `${lab.base}..exorcist/${huntId}`]), name).toBe('services/payments/src/refunds.ts');
    }
    // The login folder of the parent home was linked into the fixer's own home and never changed.
    expect(modes()).toBe(before);
    expect(readFileSync(stateFile, 'utf8')).toBe('login state');
  }, 300_000);

  it('ends a stream that is refused by design as a revert, with the reason and the detail in the view', async () => {
    for (const [name, detail] of Object.entries(REFUSED)) {
      const { view } = await runStream(name);
      expect(validateProposalView(view).ok, name).toBe(true);
      expect(view, name).toMatchObject({ status: 'open', kind: 'revert', aiFailReason: 'agent_failed' });
      expect(view.aiFailDetail, name).toMatch(detail);
    }
    expect(modes()).toBe('700 600');
  }, 120_000);

  it('leaks nothing: no token, no home or work path in the logs or in the pull requests', () => {
    const all = [...app.server.logs, JSON.stringify(github.pulls)].join('\n');
    for (const secret of [DUMMY_GITHUB_TOKEN, CHAOS_TOKEN, ADMIN_TOKEN, LAB_TOKEN, root]) expect(all, secret).not.toContain(secret);
  });
});
