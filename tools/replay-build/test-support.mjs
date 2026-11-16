// Rows for the tests of the builder: the shape `readIncidentRows` returns, made up, no database.
export const SHA = '65c0fca31d0df62c4bab40d2d854c81b1044c650';
export const BASE = Date.UTC(2026, 10, 15, 9, 58, 0);
export const at = (s) => new Date(BASE + s * 1000);
/** Text a real log could hold, built at run time so that no file of the repository holds it. */
export const PLANTED = {
  email: ['ops', 'example.test'].join('@'),
  homePath: ['', 'Users', 'someone', 'work'].join('/'),
  tempPath: ['', 'tmp', 'x', 'out.log'].join('/'),
  token: ['gh', 'p_'].join('') + 'A1b2C3d4E5f6G7h8I9j0',
  ip: ['10', '4', '7', '9'].join('.'),
  host: ['db1', 'corp'].join('.'),
  uuid: '123e4567-e89b-12d3-a456-426614174000',
  longRun: 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3',
  aws: ['ec2-1-2-3-4.compute-1', 'amazonaws.com'].join('.'),
  ipv6: ['fe80', '', '1ff'].join(':'),
  bareHost: ['staging', 'example', 'com'].join('.'),
  rootPath: ['', 'root', 'work', 'x'].join('/'),
};
export function makeRows({ hunt = {}, proposal = {}, incident = {}, signals, noHunt = false, noProposal = false } = {}) {
  const sig = [];
  for (let s = -30; s <= 120; s += 5) {
    for (const service of ['gate', 'orders', 'payments', 'ledger']) {
      const spike = service === 'payments' && s >= 25 && s < 100;
      sig.push({ service, kind: 'error_rate', value: spike ? 0.35 : 0.01, at: at(s) });
      sig.push({ service, kind: 'p95_ms', value: 120, at: at(s) });
      sig.push({ service, kind: 'up', value: 1, at: at(s) });
    }
  }
  return {
    incident: { id: 'real-incident-id', service: 'payments', openedAt: at(30), closedAt: at(100), peakLevel: 2, ...incident },
    services: [
      { name: 'gate', roomX: 0, roomY: 0 },
      { name: 'orders', roomX: 1, roomY: 0 },
      { name: 'payments', roomX: 0, roomY: 1 },
      { name: 'ledger', roomX: 1, roomY: 1 },
    ],
    signals: signals ?? sig,
    hunt: noHunt
      ? null
      : {
          id: 'real-hunt-id',
          incidentId: 'real-incident-id',
          service: 'payments',
          status: 'succeeded',
          trigger: 'auto',
          endReason: 'diagnosed',
          invalidCheck: null,
          model: 'claude-sonnet-5.5',
          credits: 0.5,
          creditsEstimated: false,
          toolCalls: 2,
          culpritDeploy: 'd-7',
          culpritSha: SHA,
          culpritService: 'payments',
          summary: 'The refund guard was removed.',
          fixHint: 'Restore the guard.',
          stopDetail: null,
          diagnosedBy: null,
          linkedHuntId: null,
          startedAt: at(41),
          finishedAt: at(70),
          durationMs: 29_000,
          createdAt: at(40),
          steps: [
            { index: 1, tool: 'query_metrics', summary: 'metrics payments error_ratio 15m', at: at(45) },
            { index: 2, tool: 'diff_commit', summary: 'diff of the culprit commit', at: at(60) },
          ],
          evidence: [{ order: 1, kind: 'deploy', ref: 'deploy:d-7', detail: 'Deploy d-7 went out before the spike.', cited: true }],
          ...hunt,
        },
    proposal: noProposal
      ? null
      : {
          id: 'real-proposal-id',
          huntId: 'real-hunt-id',
          attempt: 1,
          kind: 'ai_patch',
          status: 'deployed',
          failReason: null,
          aiFailReason: null,
          prNumber: 7,
          prUrl: 'https://github.com/Akar-Samudra-Artifisial/Haunted-Lab/pull/7',
          mergedBy: 'some-person',
          checks: [{ name: 'non_empty', ok: true }],
          credits: 0.1,
          creditsEstimated: false,
          createdAt: at(72),
          openedAt: at(80),
          mergedAt: at(90),
          deployedAt: at(95),
          finishedAt: at(95),
          updatedAt: new Date(),
          ...proposal,
        },
    window: { startMs: BASE - 30_000, endMs: BASE + 130_000 },
  };
}
