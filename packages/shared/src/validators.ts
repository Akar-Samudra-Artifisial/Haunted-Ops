import {
  checkFiniteNumber,
  checkHauntLevel,
  checkHauntReasonKind,
  checkInteger,
  checkIsoTimestamp,
  checkNonEmptyString,
  checkNullable,
  checkObject,
  checkOneOf,
  checkServiceName,
  checkSignalKind,
  makeValidator,
} from './checks.js';
import { checkHuntSummary } from './hunts.js';
import type { HauntLevel, HauntReason, IngestStatus, ServiceName, ServiceState, SignalKind } from './types.js';

/**
 * Validators of the wire types. The generic helpers live in `checks.ts` and are re-exported here,
 * so existing imports from `validators.js` keep working.
 */
export * from './checks.js';

export const checkHauntReason = checkObject({ kind: checkHauntReasonKind, value: checkFiniteNumber });
export const checkNullableNumber = checkNullable(checkFiniteNumber);

export const checkSampleShape = {
  errorRate: checkNullableNumber,
  p95Ms: checkNullableNumber,
  up: checkNullableNumber,
};

export const checkServiceMetrics = checkObject({ ...checkSampleShape, at: checkIsoTimestamp });

export const checkOpenIncident = checkObject({
  id: checkNonEmptyString,
  openedAt: checkIsoTimestamp,
  peakLevel: checkHauntLevel,
});

export const checkServiceState = checkObject({
  name: checkServiceName,
  room: checkObject({ x: checkInteger, y: checkInteger }),
  hauntLevel: checkHauntLevel,
  reason: checkNullable(checkHauntReason),
  metrics: checkNullable(checkServiceMetrics),
  openIncident: checkNullable(checkOpenIncident),
  updatedAt: checkIsoTimestamp,
  hunt: checkNullable(checkHuntSummary),
});

export const checkIngestStatus = checkObject({
  state: checkOneOf(['ok', 'stale']),
  at: checkIsoTimestamp,
  lastSuccessAt: checkNullable(checkIsoTimestamp),
});

export const validateIngestStatus = makeValidator<IngestStatus>(checkIngestStatus);
export const validateHauntReason = makeValidator<HauntReason>(checkHauntReason);

export const validateServiceName = makeValidator<ServiceName>(checkServiceName);
export const validateHauntLevel = makeValidator<HauntLevel>(checkHauntLevel);
export const validateSignalKind = makeValidator<SignalKind>(checkSignalKind);
export const validateServiceState = makeValidator<ServiceState>(checkServiceState);

/** Validates an array of Service state. */
export const validateServiceStates = makeValidator<ServiceState[]>((input, path, errors) => {
  if (!Array.isArray(input)) {
    errors.push(path);
    return;
  }
  input.forEach((item, i) => checkServiceState(item, `${path}[${i}]`, errors));
});
