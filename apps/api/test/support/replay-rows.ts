import type { PrismaClient } from '../../src/prisma/client.js';
/** The one SHA of the synthetic incident (40 hex). */
export const SYNTHETIC_SHA = '65c0fca31d0df62c4bab40d2d854c81b1044c650';
const BASE = Date.UTC(2026, 10, 15, 9, 58, 0);
const at = (s: number): Date => new Date(BASE + s * 1000);
/** Pieces of text a real log could hold. They are built here, at run time, so that no file of the repository holds them. */
export const PLANTED = {
  email: ['ops', 'example.test'].join('@'),
  homePath: ['', 'Users', 'someone', 'work', 'payments'].join('/'),
  tempPath: ['', 'tmp', 'build', 'out.log'].join('/'),
  token: ['gh', 'p_'].join('') + 'A1b2C3d4E5f6G7h8I9j0',
  ip: ['10', '4', '7', '9'].join('.'),
  host: ['db1', 'corp'].join('.'),
  longRun: 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3',
  login: 'some-person',
} as const;
/**
 * Inserts one incident of the lab, made up for tests: payments gets an error spike after a bad deploy, the Exorcist
 * finds the culprit commit, a fix is merged and deployed. Nothing in it was recorded. Returns the ids to build from.
 */
export async function insertSyntheticIncident(prisma: PrismaClient): Promise<{ incidentId: string; huntId: string; proposalId: string }> {
  const services = new Map((await prisma.service.findMany()).map((s) => [s.name, s.id]));
  const id = (name: string): string => services.get(name) as string;
  const rows: Array<{ serviceId: string; kind: 'error_rate' | 'p95_ms' | 'up'; value: number; at: Date }> = [];
  for (let s = -30; s <= 170; s += 5) {
    for (const name of ['gate', 'orders', 'payments', 'ledger']) {
      const spike = name === 'payments' && s >= 25 && s < 125;
      const wobble = name === 'orders' && s >= 40 && s < 100;
      rows.push({ serviceId: id(name), kind: 'error_rate', value: spike ? 0.35 : wobble ? 0.07 : 0.01, at: at(s) });
      rows.push({ serviceId: id(name), kind: 'p95_ms', value: spike ? 340 : 120, at: at(s) });
      rows.push({ serviceId: id(name), kind: 'up', value: 1, at: at(s) });
    }
  }
  await prisma.signal.createMany({ data: rows });
  const incident = await prisma.incident.create({ data: { serviceId: id('payments'), openedAt: at(30), closedAt: at(140), peakLevel: 2 } });
  const hunt = await prisma.hunt.create({
    data: {
      incidentId: incident.id,
      serviceId: id('payments'),
      status: 'succeeded',
      trigger: 'auto',
      endReason: 'diagnosed',
      model: 'claude-sonnet-5.5',
      credits: 0.61,
      toolCalls: 5,
      culpritDeploy: 'd-7',
      culpritSha: SYNTHETIC_SHA,
      culpritService: 'payments',
      summary: `Deploy d-7 removed the refund guard in payments, so refunds without an order fail. Contact ${PLANTED.email} for the owner.`,
      fixHint: 'Restore the guard that checks the order before a refund.',
      startedAt: at(41),
      finishedAt: at(75),
      durationMs: 34_000,
      createdAt: at(40),
    },
  });
  const steps: Array<[string, string]> = [
    ['query_metrics', 'metrics payments error_ratio 15m'],
    ['search_errors', 'errors payments since the first spike'],
    ['tail_logs', 'logs payments around the first error'],
    ['recent_deploys', 'deploys payments in the last hour'],
    ['diff_commit', `diff of commit ${SYNTHETIC_SHA.slice(0, 7)} in payments`],
  ];
  const times = [45, 52, 58, 65, 72];
  await prisma.huntStep.createMany({ data: steps.map(([tool, summary], i) => ({ huntId: hunt.id, index: i + 1, tool, summary, at: at(times[i] as number) })) });
  await prisma.evidence.createMany({
    data: [
      { huntId: hunt.id, order: 1, kind: 'metric', ref: 'metric:payments:error_rate', detail: 'The error ratio of payments went from 0.01 to 0.35 within one minute.', cited: true },
      { huntId: hunt.id, order: 2, kind: 'log', ref: 'log:payments:1', detail: `refund failed for ${PLANTED.email} from ${PLANTED.ip} on ${PLANTED.host} (${PLANTED.homePath}, ${PLANTED.tempPath}) key ${PLANTED.token}`, cited: false },
      { huntId: hunt.id, order: 3, kind: 'error', ref: 'error:payments:1', detail: `TypeError: order is undefined ${PLANTED.longRun}`, cited: true },
      { huntId: hunt.id, order: 4, kind: 'deploy', ref: 'deploy:d-7', detail: 'Deploy d-7 went to payments two minutes before the first error.', cited: true },
      { huntId: hunt.id, order: 5, kind: 'commit', ref: `commit:${SYNTHETIC_SHA}`, detail: 'The commit removes the guard around the order lookup.', cited: true },
    ],
  });
  const proposal = await prisma.proposal.create({
    data: {
      huntId: hunt.id,
      attempt: 1,
      kind: 'ai_patch',
      status: 'deployed',
      prNumber: 7,
      prUrl: 'https://github.com/Akar-Samudra-Artifisial/Haunted-Lab/pull/7',
      branch: 'exorcist/synthetic',
      baseBranch: 'incident/synthetic',
      baseSha: SYNTHETIC_SHA,
      headSha: SYNTHETIC_SHA,
      mergeSha: SYNTHETIC_SHA,
      mergedBy: PLANTED.login,
      checks: [
        { name: 'non_empty', ok: true },
        { name: 'scope', ok: true },
        { name: 'syntax', ok: true },
        { name: 'tests', ok: true },
      ],
      aiFailDetail: `agent_failed: could not read ${PLANTED.homePath}`,
      credits: 0.2,
      createdAt: at(78),
      openedAt: at(95),
      mergedAt: at(115),
      deployedAt: at(130),
      finishedAt: at(130),
    },
  });
  return { incidentId: incident.id, huntId: hunt.id, proposalId: proposal.id };
}
