import {
  SERVICE_NAMES,
  replayReviewHash,
  type HuntDetail,
  type HuntSummary,
  type ProposalSummary,
  type ProposalView,
  type ReplayFile,
  type ReplayReview,
  type ServiceName,
  type ServiceState,
} from '../src/index.js';
export const HUNT_ID = 'rhuntaaaaaaaaaaaaaaaaaaaa';
export const INCIDENT_ID = 'rincidentaaaaaaaaaaaaaaa';
export const PROPOSAL_ID = 'rproposalaaaaaaaaaaaaaaa';
export const SHA = '65c0fca31d0df62c4bab40d2d854c81b1044c650';
export const PR_URL = 'https://github.com/Akar-Samudra-Artifisial/Haunted-Lab/pull/7';
const ROOMS: Record<ServiceName, { x: number; y: number }> = { gate: { x: 0, y: 0 }, orders: { x: 1, y: 0 }, payments: { x: 0, y: 1 }, ledger: { x: 1, y: 1 } };
export const iso = (ms: number): string => new Date(Date.UTC(2026, 10, 15, 0, 0, 0) + ms).toISOString();
export function services(level: 0 | 4 = 0, hunt: HuntSummary | null = null, proposal: ProposalSummary | null = null): ServiceState[] {
  return SERVICE_NAMES.map((name) => ({
    name,
    room: ROOMS[name],
    hauntLevel: name === 'payments' ? level : 0,
    reason: name === 'payments' && level === 4 ? { kind: 'down' as const, value: 0 } : null,
    metrics: { errorRate: name === 'payments' && level === 4 ? 0.9 : 0, p95Ms: 120, up: name === 'payments' && level === 4 ? 0 : 1, at: iso(0) },
    openIncident: name === 'payments' && level === 4 ? { id: INCIDENT_ID, openedAt: iso(2000), peakLevel: 4 } : null,
    updatedAt: iso(0),
    hunt: name === 'payments' ? hunt : null,
    proposal: name === 'payments' ? proposal : null,
  }));
}
export const summary: HuntSummary = {
  id: HUNT_ID,
  incidentId: INCIDENT_ID,
  service: 'payments',
  trigger: 'auto',
  status: 'succeeded',
  reason: 'diagnosed',
  steps: [{ index: 1, tool: 'query_metrics', summary: 'metrics payments error_ratio 15m', at: iso(4000) }],
  stepCount: 1,
  evidenceCount: 1,
  diagnosis: { culpritDeploy: 'd-7', culpritSha: SHA, culpritService: 'payments', summary: 'The refund guard was removed.' },
  credits: 0.6,
  queuedAt: iso(3000),
  startedAt: iso(3500),
  finishedAt: iso(6000),
  diagnosedBy: null,
};
export const proposalSummary: ProposalSummary = {
  id: PROPOSAL_ID,
  huntId: HUNT_ID,
  attempt: 1,
  kind: 'ai_patch',
  status: 'open',
  prNumber: 7,
  prUrl: PR_URL,
  mergedBy: null,
  checks: [{ name: 'non_empty', ok: true }],
  failReason: null,
  aiFailReason: null,
  updatedAt: iso(8000),
};
export const proposalView: ProposalView = {
  ...proposalSummary,
  aiFailDetail: null,
  service: 'payments',
  credits: 0.2,
  creditsEstimated: false,
  createdAt: iso(7000),
  openedAt: iso(8000),
  mergedAt: null,
  deployedAt: null,
};
export const huntDetail: HuntDetail = {
  ...summary,
  model: 'claude-sonnet-5.5',
  toolCalls: 1,
  durationMs: 2500,
  invalidCheck: null,
  stopDetail: null,
  creditsEstimated: false,
  linkedHuntId: null,
  allSteps: summary.steps,
  evidence: [{ index: 1, kind: 'deploy', ref: 'deploy:d-7', detail: 'Deploy d-7 removed the refund guard.', cited: true }],
  fixHint: 'Restore the guard.',
  proposal: proposalSummary,
};
/** A small valid replay (a calm house, a dark room, a hunt, a pull request), not reviewed yet (`review: null`). */
export function goodReplay(): ReplayFile {
  return {
    version: 1,
    id: 'good-replay',
    title: 'Synthetic: payments goes dark',
    scenario: 'dark-room',
    recordedOn: '2026-11-15',
    durationMs: 10_000,
    review: null,
    frames: [
      { t: 0, services: services(0), hunt: null, proposal: null },
      { t: 2000, services: services(4) },
      { t: 6000, services: services(4, summary), hunt: huntDetail },
      { t: 8000, services: services(4, summary, proposalSummary), proposal: proposalView },
    ],
  };
}
/** The file with a review bound to its content (`sha256` of the file as it is now). */
export function withReview(file: ReplayFile, review: Partial<Omit<ReplayReview, 'sha256'>> = {}): ReplayFile {
  return { ...file, review: { reviewedOn: '2026-11-16', by: 'TEST', note: 'Synthetic file for tests.', ...review, sha256: replayReviewHash(file) } };
}
