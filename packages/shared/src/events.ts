import type { HauntLevel, HauntReason, IngestStatus, Result, Sample, ServiceName, ServiceState, SignalKind } from './types.js';
import {
  checkArrayOf,
  checkFiniteNumber,
  checkHauntLevel,
  checkHauntReason,
  checkIngestStatus,
  checkNullable,
  checkSampleShape,
  checkIsoTimestamp,
  checkNonEmptyString,
  checkObject,
  checkOneOf,
  checkServiceName,
  checkServiceState,
  checkSignalKind,
  fail,
  makeValidator,
  type Check,
} from './validators.js';
import { HUNT_EVENT_NAMES, huntPayloadChecks, type HuntEventPayloads } from './hunts.js';
import { PROPOSAL_EVENT_NAMES, proposalPayloadChecks, type ProposalEventPayloads } from './proposals.js';

/** Domain events carry an id and are kept in the ring buffer for resume. */
export interface DomainEventPayloads {
  /** `previousLevel` is the level before this change (equal to the new level when only the reason changed). */
  'service.updated': { service: ServiceState; previousLevel: HauntLevel };
  'signal.recorded': { service: ServiceName; kind: SignalKind; value: number; at: string };
  /** `level` and `reason` are what the Service had when the Incident opened. */
  'incident.opened': {
    incidentId: string;
    service: ServiceName;
    openedAt: string;
    level: HauntLevel;
    reason: HauntReason | null;
  };
  'incident.closed': { incidentId: string; service: ServiceName; closedAt: string; peakLevel: HauntLevel };
  /** One event per successful poll, with the Sample of every Service. */
  'ingest.polled': { at: string; samples: Array<Sample & { service: ServiceName }> };
  'ingest.status': IngestStatus;
  'hunt.queued': HuntEventPayloads['hunt.queued'];
  'hunt.started': HuntEventPayloads['hunt.started'];
  'hunt.step': HuntEventPayloads['hunt.step'];
  'hunt.evidence': HuntEventPayloads['hunt.evidence'];
  'hunt.diagnosis': HuntEventPayloads['hunt.diagnosis'];
  'hunt.finished': HuntEventPayloads['hunt.finished'];
  'proposal.started': ProposalEventPayloads['proposal.started'];
  'proposal.checks': ProposalEventPayloads['proposal.checks'];
  'proposal.opened': ProposalEventPayloads['proposal.opened'];
  'proposal.merged': ProposalEventPayloads['proposal.merged'];
  'proposal.deployed': ProposalEventPayloads['proposal.deployed'];
  'proposal.rejected': ProposalEventPayloads['proposal.rejected'];
  'proposal.failed': ProposalEventPayloads['proposal.failed'];
}

/**
 * Why the server cannot resume a stream:
 * - too_old: events after the id were already dropped from the buffer
 * - ahead: the id is past the latest id of this boot
 * - malformed: the id is not `<bootId>-<n>`
 * - restarted: the id belongs to another server boot
 */
export const RESYNC_REASONS = ['too_old', 'ahead', 'malformed', 'restarted'] as const;
export type ResyncReason = (typeof RESYNC_REASONS)[number];

/** Control events carry no id and are never stored. */
export interface ControlEventPayloads {
  connected: { bootId: string };
  heartbeat: { at: string };
  resync: { reason: ResyncReason };
}

/** Later specs extend these maps (for example with hunt events). */
export type SsePayloads = DomainEventPayloads & ControlEventPayloads;
export type DomainEventName = keyof DomainEventPayloads;
export type ControlEventName = keyof ControlEventPayloads;
export type SseEventName = keyof SsePayloads;

export const DOMAIN_EVENT_NAMES = [
  'service.updated',
  'signal.recorded',
  'incident.opened',
  'incident.closed',
  'ingest.polled',
  'ingest.status',
  ...HUNT_EVENT_NAMES,
  ...PROPOSAL_EVENT_NAMES,
] as const satisfies readonly DomainEventName[];
export const CONTROL_EVENT_NAMES = ['connected', 'heartbeat', 'resync'] as const satisfies readonly ControlEventName[];
export const SSE_EVENT_NAMES: readonly SseEventName[] = [...DOMAIN_EVENT_NAMES, ...CONTROL_EVENT_NAMES];

export function isDomainEventName(name: unknown): name is DomainEventName {
  return (DOMAIN_EVENT_NAMES as readonly unknown[]).includes(name);
}

export function isSseEventName(name: unknown): name is SseEventName {
  return (SSE_EVENT_NAMES as readonly unknown[]).includes(name);
}

/** A boot id is 12 lowercase hex characters, random per server process. */
export const BOOT_ID_PATTERN = /^[0-9a-f]{12}$/;
const EVENT_ID_PATTERN = /^([0-9a-f]{12})-(\d{1,15})$/;

export interface EventId {
  bootId: string;
  seq: number;
}

/** Wire form of a domain event id: `<bootId>-<seq>`. */
export function formatEventId(bootId: string, seq: number): string {
  return `${bootId}-${seq}`;
}

/** Parses `<bootId>-<seq>`; anything else is null. */
export function parseEventId(value: unknown): EventId | null {
  if (typeof value !== 'string') return null;
  const m = EVENT_ID_PATTERN.exec(value.trim());
  if (!m) return null;
  const seq = Number(m[2]);
  if (!Number.isSafeInteger(seq)) return null;
  return { bootId: m[1] as string, seq };
}

const checkBootId: Check = (input, path, errors) => {
  if (typeof input !== 'string' || !BOOT_ID_PATTERN.test(input)) errors.push(path);
};

const payloadChecks: { [K in SseEventName]: Check } = {
  'service.updated': checkObject({ service: checkServiceState, previousLevel: checkHauntLevel }),
  'signal.recorded': checkObject({
    service: checkServiceName,
    kind: checkSignalKind,
    value: checkFiniteNumber,
    at: checkIsoTimestamp,
  }),
  'incident.opened': checkObject({
    incidentId: checkNonEmptyString,
    service: checkServiceName,
    openedAt: checkIsoTimestamp,
    level: checkHauntLevel,
    reason: checkNullable(checkHauntReason),
  }),
  'incident.closed': checkObject({
    incidentId: checkNonEmptyString,
    service: checkServiceName,
    closedAt: checkIsoTimestamp,
    peakLevel: checkHauntLevel,
  }),
  'ingest.polled': checkObject({
    at: checkIsoTimestamp,
    samples: checkArrayOf(checkObject({ service: checkServiceName, ...checkSampleShape })),
  }),
  'ingest.status': checkIngestStatus,
  ...huntPayloadChecks,
  ...proposalPayloadChecks,
  connected: checkObject({ bootId: checkBootId }),
  heartbeat: checkObject({ at: checkIsoTimestamp }),
  resync: checkObject({ reason: checkOneOf(RESYNC_REASONS) }),
};

const payloadValidators = Object.fromEntries(
  Object.entries(payloadChecks).map(([name, check]) => [name, makeValidator(check)]),
) as { [K in SseEventName]: (input: unknown) => Result<SsePayloads[K]> };

/** Validates the payload of a named SSE event. Unknown names fail with path `name`. */
export function validateSseEvent<K extends SseEventName>(name: K, input: unknown): Result<SsePayloads[K]>;
export function validateSseEvent(name: string, input: unknown): Result<unknown>;
export function validateSseEvent(name: string, input: unknown): Result<unknown> {
  if (!isSseEventName(name)) return fail(['name']);
  return payloadValidators[name](input);
}

/** One SSE frame. Domain events have an id (`<bootId>-<seq>`); control events do not. */
export interface SseFrame {
  id?: string;
  event: string;
  data: unknown;
}

/** Formats one frame in the SSE wire format. JSON never contains raw newlines. */
export function formatSseFrame(frame: SseFrame): string {
  const lines: string[] = [];
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  lines.push(`event: ${frame.event}`);
  lines.push(`data: ${JSON.stringify(frame.data)}`);
  return `${lines.join('\n')}\n\n`;
}

/** Parses one SSE frame produced by formatSseFrame. Returns null for anything else. */
export function parseSseFrame(text: string): SseFrame | null {
  const body = text.endsWith('\n\n') ? text.slice(0, -2) : text;
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of body.split('\n')) {
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    const field = line.slice(0, sep);
    const value = line.slice(sep + 1).replace(/^ /, '');
    if (field === 'id') {
      if (value === '' || value.includes('\0')) return null;
      id = value;
    } else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (event === undefined || data.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(data.join('\n'));
    return id === undefined ? { event, data: parsed } : { id, event, data: parsed };
  } catch {
    return null;
  }
}
