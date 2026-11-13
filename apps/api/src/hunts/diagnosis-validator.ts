import { HUNT_LIMITS, isCulpritCandidate, validateServiceName, type DiagnosisCheck, type ServiceName } from '@haunted-ops/shared';
import { parseToolInput, type SubmitDiagnosisInput } from '@haunted-ops/exorcist-mcp/schemas';
import type { LedgerLine } from '@haunted-ops/exorcist-mcp/ledger';
import { sanitizeModelText } from './model-text.js';
import type { ValidDiagnosisRecord } from './hunt-store.js';
import type { LabLookup } from './lab-client.js';

/** A deploy may be recorded up to this long after the Incident opened and still be its culprit. */
export const DEPLOY_SLACK_MS = 60_000;
/** The lab is asked for deploys from this long before the Incident opened. */
export const DEPLOY_LOOKBACK_MS = 6 * 60 * 60 * 1000;

export interface IncidentForValidation {
  service: ServiceName;
  openedAt: Date;
}

export type DiagnosisVerdict =
  | { ok: true; diagnosis: ValidDiagnosisRecord }
  | { ok: false; reason: 'no_diagnosis' }
  | { ok: false; reason: 'invalid_diagnosis'; check: DiagnosisCheck };

const invalid = (check: DiagnosisCheck): DiagnosisVerdict => ({ ok: false, reason: 'invalid_diagnosis', check });

/** Equality of two parsed inputs. Both come from the same strict schema, so key order is the same. */
export function sameInput(a: SubmitDiagnosisInput, b: SubmitDiagnosisInput): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const isoNoMillis = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Decides whether the diagnosis a Hunt submitted is grounded. The checks run in the order of the
 * design table and stop at the first failure. Every fact is compared with what the lab served and
 * what the MCP server recorded in the ledger; nothing the model wrote is believed on its own.
 *
 * @param streamInput the `rawInput` of the `submit_diagnosis` call seen in the stream, or undefined
 */
export async function validateDiagnosis(
  incident: IncidentForValidation,
  ledger: readonly LedgerLine[],
  streamInput: unknown,
  lab: LabLookup,
): Promise<DiagnosisVerdict> {
  const diagnoses = ledger.filter((l): l is Extract<LedgerLine, { type: 'diagnosis' }> => l.type === 'diagnosis');
  if (diagnoses.length === 0) return { ok: false, reason: 'no_diagnosis' };

  // stream: the same input on both channels, and a valid one.
  if (diagnoses.length !== 1) return invalid('stream_mismatch');
  const fromLedger = parseToolInput('submit_diagnosis', (diagnoses[0] as { input: unknown }).input);
  const fromStream = parseToolInput('submit_diagnosis', streamInput);
  if (!fromLedger.ok || !fromStream.ok || !sameInput(fromLedger.value, fromStream.value)) return invalid('stream_mismatch');
  const input = fromLedger.value;

  if (input.service !== incident.service) return invalid('service');

  const deploys = await lab.deploys(isoNoMillis(incident.openedAt.getTime() - DEPLOY_LOOKBACK_MS));
  if (deploys.kind !== 'ok') return invalid('lab_unavailable');
  const record = deploys.value.find((d) => d.id === input.culprit_deploy);
  if (record === undefined) return invalid('deploy_unknown');
  // The cause may be a recent deploy of the hunted Service or of a Service it depends on (a fault downstream breaks every caller).
  const culpritService = validateServiceName(record.service);
  if (!culpritService.ok || !isCulpritCandidate(incident.service, culpritService.value)) return invalid('deploy_service');
  const at = Date.parse(record.time);
  if (!Number.isFinite(at) || at > incident.openedAt.getTime() + DEPLOY_SLACK_MS) return invalid('deploy_after_incident');
  if (!/^[0-9a-f]{40}$/.test(record.sha) || !record.sha.startsWith(input.culprit_sha)) return invalid('sha_mismatch');

  const reach = await lab.commitReachable(record.sha);
  if (reach.kind === 'unavailable') return invalid('lab_unavailable');
  if (reach.kind === 'missing') return invalid('sha_unreachable');

  const handles = new Map<string, string>();
  for (const l of ledger) if (l.type === 'handle') handles.set(l.handle, l.kind);
  for (const e of input.evidence) {
    const kind = handles.get(e.ref);
    if (kind === undefined) return invalid('evidence_unseen');
    if (kind !== e.kind) return invalid('evidence_kind');
  }
  const refs = [...new Set(input.evidence.map((e) => e.ref))];
  if (!refs.includes(`deploy:${input.culprit_deploy}`) && !refs.includes(`commit:${record.sha}`)) return invalid('culprit_not_cited');

  // The summary and the fix hint are the model's own words on a public page: plain, one line, no link, no markup.
  const summary = sanitizeModelText(input.summary, HUNT_LIMITS.summary);
  return {
    ok: true,
    diagnosis: {
      culpritDeploy: input.culprit_deploy,
      culpritSha: record.sha,
      culpritService: culpritService.value,
      // A summary that was only links, markup or control characters still needs some text.
      summary: summary === '' ? `culprit ${input.culprit_deploy}` : summary,
      fixHint: sanitizeModelText(input.fix_hint, HUNT_LIMITS.fixHint),
      cited: refs.slice(0, HUNT_LIMITS.cited),
    },
  };
}
