import fc from 'fast-check';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SERVICE_NAMES } from '@haunted-ops/shared';
import { startFakeLab, type FakeLab } from '../../../../tools/fake-kiro-cli/fake-lab.mjs';
import { deployFixAllowed, parseDeployFixBody } from '../../../../tools/fake-kiro-cli/deploy-fix-rule.mjs';
import { HttpLabClient } from '../hunts/lab-client.js';
import { HttpChaosClient, HttpFixLab, type PostFetch } from './lab-deploy-client.js';

const LAB_TOKEN = 'lab-read-token-0123456789-abcdef';
const CHAOS_TOKEN = 'chaos-token-0123456789-abcdefghij';
const HUNT = 'cmhuntaaaaaaaaaaaaaaaaaaa';
const REF = `incident/${HUNT}`;
const M = 'c'.repeat(40);
const BASE = 'a'.repeat(40);
const FIX = 'b'.repeat(40);

describe('HttpChaosClient and the deploy-fix route of the fake lab', () => {
  let lab: FakeLab;
  beforeAll(async () => {
    lab = await startFakeLab({ token: LAB_TOKEN, chaosToken: CHAOS_TOKEN });
  });
  afterAll(async () => {
    await lab.close();
  });
  beforeEach(() => {
    lab.refs.clear();
    lab.allowedHeads.length = 0;
    lab.deployed.length = 0;
    lab.deployFix.calls.length = 0;
    lab.deployFix.mode = 'ok';
    lab.allowedHeads.push(BASE);
    lab.refs.set(REF, { head: M, chain: [{ sha: M, files: ['services/payments/src/charge.js'] }, { sha: FIX, files: ['services/payments/src/charge.js'] }, { sha: BASE, files: ['services/payments/package.json'] }] });
  });
  const client = (token = CHAOS_TOKEN) => new HttpChaosClient(lab.url, token);

  it('asks the lab to deploy exactly { service, ref, sha }, and the record then shows up in the deploy list with actor exorcist', async () => {
    const out = await client().deployFix({ service: 'payments', huntId: HUNT, sha: M });
    expect(out).toEqual({ kind: 'ok', deployId: 'd-900' });
    expect(lab.deployFix.calls).toEqual([{ authorized: true, body: { service: 'payments', ref: REF, sha: M } }]);
    const fixLab = new HttpFixLab(new HttpLabClient(lab.url, LAB_TOKEN), client());
    const list = await fixLab.deploys('2026-01-01T00:00:00Z');
    expect(list.kind === 'ok' && list.value.find((d) => d.sha === M)).toMatchObject({ id: 'd-900', service: 'payments', sha: M, actor: 'exorcist' });
  });

  it('is refused with the status when the lab says no, and the lab answers the contract', async () => {
    expect(await client('chaos-token-WRONG-0123456789-abcdefgh').deployFix({ service: 'payments', huntId: HUNT, sha: M })).toEqual({ kind: 'rejected', status: 401 });
    // The ref is not known to the lab, is not at this head, or has a commit outside the service.
    expect(await client().deployFix({ service: 'payments', huntId: 'cmhuntbbbbbbbbbbbbbbbbbbb', sha: M })).toEqual({ kind: 'rejected', status: 404 });
    expect(await client().deployFix({ service: 'payments', huntId: HUNT, sha: 'd'.repeat(40) })).toEqual({ kind: 'rejected', status: 409 });
    lab.refs.set(REF, { head: M, chain: [{ sha: M, files: ['services/orders/src/x.js'] }, { sha: BASE, files: [] }] });
    expect(await client().deployFix({ service: 'payments', huntId: HUNT, sha: M })).toEqual({ kind: 'rejected', status: 422 });
    lab.refs.set(REF, { head: M, chain: [{ sha: M, files: ['services/payments/src/x.js'] }, { sha: FIX, files: ['services/payments/src/x.js'] }] });
    expect(await client().deployFix({ service: 'payments', huntId: HUNT, sha: M })).toEqual({ kind: 'rejected', status: 409 });
    expect(lab.deployed).toEqual([]);
  });

  it('says unavailable for a 5xx, a lab that cannot be reached, a body that is not the contract and one that is too big', async () => {
    lab.deployFix.mode = 'unavailable';
    expect(await client().deployFix({ service: 'payments', huntId: HUNT, sha: M })).toEqual({ kind: 'unavailable' });
    expect(await new HttpChaosClient('http://127.0.0.1:1', CHAOS_TOKEN).deployFix({ service: 'payments', huntId: HUNT, sha: M })).toEqual({ kind: 'unavailable' });
    const reply = (body: string, status = 200): PostFetch => async () => new Response(body, { status });
    for (const body of ['not json', '{}', '{"deployId":"x"}', `{"deployId":"d-1","pad":"${'x'.repeat(5000)}"}`]) {
      expect(await new HttpChaosClient('http://lab.invalid', CHAOS_TOKEN, reply(body)).deployFix({ service: 'payments', huntId: HUNT, sha: M }), body.slice(0, 20)).toEqual({ kind: 'unavailable' });
    }
    expect(await new HttpChaosClient('http://lab.invalid', CHAOS_TOKEN, reply('{"deployId":"d-5"}')).deployFix({ service: 'payments', huntId: HUNT, sha: M })).toEqual({ kind: 'ok', deployId: 'd-5' });
  });

  it('refuses a request that is not a valid service, hunt id and SHA before it sends anything', async () => {
    let sent = 0;
    const spy: PostFetch = async () => (sent++, new Response('{"deployId":"d-1"}'));
    const c = new HttpChaosClient('http://lab.invalid', CHAOS_TOKEN, spy);
    for (const body of [
      { service: 'nginx' as never, huntId: HUNT, sha: M },
      { service: 'payments' as const, huntId: 'main', sha: M },
      { service: 'payments' as const, huntId: '../x', sha: M },
      { service: 'payments' as const, huntId: HUNT, sha: 'abc' },
      { service: 'payments' as const, huntId: HUNT, sha: 'HEAD' },
    ]) expect(await c.deployFix(body), JSON.stringify(body)).toMatchObject({ kind: 'rejected' });
    expect(sent).toBe(0);
  });

  it('sends the token only to its own URL, as a bearer, with no redirect and a timeout', async () => {
    const seen: Array<{ url: string; init: Parameters<PostFetch>[1] }> = [];
    const spy: PostFetch = async (url, init) => (seen.push({ url, init }), new Response('{"deployId":"d-1"}'));
    await new HttpChaosClient('http://127.0.0.1:4100', CHAOS_TOKEN, spy).deployFix({ service: 'payments', huntId: HUNT, sha: M });
    expect(seen[0]?.url).toBe('http://127.0.0.1:4100/chaos/deploy-fix');
    expect(seen[0]?.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(seen[0]?.init.headers.authorization).toBe(`Bearer ${CHAOS_TOKEN}`);
    expect(seen[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(seen[0]?.init.body ?? '{}')).toEqual({ service: 'payments', ref: REF, sha: M });
  });
});

// Feature: fix-proposal-flow, Property 11: the chaos deploy contract accepts a head whose chain is clean
describe('Property 11: the chaos deploy contract accepts a head whose chain is clean', () => {
  const sha = fc.stringMatching(/^[0-9a-f]{6}$/).map((s) => `${s}${'0'.repeat(34)}`);
  const file = (service: string) =>
    fc.oneof(fc.constantFrom('src/a.js', 'src/b/c.js', 'package.json', 'test/a.test.js').map((p) => `services/${service}/${p}`), fc.constantFrom('services/orders/src/x.js', 'services/gate/src/y.js', 'packages/lab-common/index.js', 'README.md', 'services/payments-evil/src/z.js'));
  const commit = (service: string) => fc.record({ sha, files: fc.array(file(service), { maxLength: 3 }) });

  it('is true iff the sha is the head and the first-parent chain reaches an allowed head through commits that touch only the service', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SERVICE_NAMES),
        fc.array(commit('payments'), { minLength: 1, maxLength: 6 }),
        fc.array(sha, { maxLength: 3 }),
        fc.integer({ min: 0, max: 6 }),
        fc.boolean(),
        (service, rawChain, extraHeads, reachAt, headIsSha) => {
          // Make the chain's files belong to `service` or not at random, then pick where (if anywhere) an allowed head sits.
          const chain = rawChain.map((c) => ({ sha: c.sha, files: c.files.map((f) => f.replace('services/payments/', `services/${service}/`)) }));
          const allowedHeads = [...extraHeads];
          if (reachAt < chain.length) allowedHeads.push(chain[reachAt]?.sha as string);
          const head = chain[0]?.sha as string;
          const input = { head: headIsSha ? head : `${head.slice(0, 39)}1`, sha: head, chain, allowedHeads, service };
          // The oracle: walk by hand.
          let expected = headIsSha && input.head === input.sha;
          if (expected) {
            expected = false;
            for (const c of chain) {
              if (allowedHeads.includes(c.sha)) {
                expected = true;
                break;
              }
              if (!c.files.every((f) => f.startsWith(`services/${service}/`))) break;
            }
          }
          expect(deployFixAllowed(input)).toBe(expected);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('refuses a head that is not the ref head, a chain that never reaches an allowed head, an outside file, and a bad service', () => {
    const chain = [{ sha: M, files: ['services/payments/src/a.js'] }, { sha: BASE, files: [] }];
    expect(deployFixAllowed({ head: M, sha: M, chain, allowedHeads: [BASE], service: 'payments' })).toBe(true);
    expect(deployFixAllowed({ head: FIX, sha: M, chain, allowedHeads: [BASE], service: 'payments' })).toBe(false);
    expect(deployFixAllowed({ head: M, sha: M, chain, allowedHeads: ['e'.repeat(40)], service: 'payments' })).toBe(false);
    expect(deployFixAllowed({ head: M, sha: M, chain: [{ sha: M, files: ['services/orders/src/a.js'] }, chain[1] as never], allowedHeads: [BASE], service: 'payments' })).toBe(false);
    expect(deployFixAllowed({ head: M, sha: M, chain, allowedHeads: [BASE], service: 'nginx' })).toBe(false);
    expect(deployFixAllowed({ head: M, sha: M, chain: [], allowedHeads: [BASE], service: 'payments' })).toBe(false);
    // A head that is itself an allowed head needs no commit of its own.
    expect(deployFixAllowed({ head: BASE, sha: BASE, chain: [{ sha: BASE, files: ['services/orders/x.js'] }], allowedHeads: [BASE], service: 'payments' })).toBe(true);
  });

  it('parses only the exact body { service, ref, sha }', () => {
    expect(parseDeployFixBody({ service: 'payments', ref: REF, sha: M })).toEqual({ service: 'payments', ref: REF, sha: M });
    for (const bad of [null, [], 'x', {}, { service: 'payments', ref: REF }, { service: 'payments', ref: REF, sha: M, extra: 1 }, { service: 'nginx', ref: REF, sha: M }, { service: 'payments', ref: 'main', sha: M }, { service: 'payments', ref: 'scenario/error-spike', sha: M }, { service: 'payments', ref: REF, sha: 'abc' }]) {
      expect(parseDeployFixBody(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
