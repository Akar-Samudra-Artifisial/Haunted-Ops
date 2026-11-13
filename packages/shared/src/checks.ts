import { HAUNT_LEVELS, HAUNT_REASON_KINDS, SERVICE_NAMES, SIGNAL_KINDS, type Result } from './types.js';

/**
 * Plain, total check helpers. They never throw: any input gives a Result.
 * Objects are exact: unknown keys are rejected so producer and consumer cannot drift.
 * This module imports only types, so `validators.ts` and `hunts.ts` can both build on it.
 */

export type Check = (input: unknown, path: string, errors: string[]) => void;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function isPlainObject(input: unknown): input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const proto: unknown = Object.getPrototypeOf(input);
  return proto === Object.prototype || proto === null;
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T>(errors: string[]): Result<T> {
  return { ok: false, errors };
}

/** Wraps a check into a total validator. Any unexpected exception becomes an error path. */
export function makeValidator<T>(check: Check): (input: unknown) => Result<T> {
  return (input: unknown): Result<T> => {
    const errors: string[] = [];
    try {
      check(input, '$', errors);
    } catch {
      errors.push('$');
    }
    return errors.length === 0 ? ok(input as T) : fail(errors);
  };
}

export const checkOneOf =
  (values: readonly unknown[]): Check =>
  (input, path, errors) => {
    if (!values.includes(input)) errors.push(path);
  };

export const checkInteger: Check = (input, path, errors) => {
  if (typeof input !== 'number' || !Number.isInteger(input)) errors.push(path);
};

export const checkFiniteNumber: Check = (input, path, errors) => {
  if (typeof input !== 'number' || !Number.isFinite(input)) errors.push(path);
};

export const checkNonEmptyString: Check = (input, path, errors) => {
  if (typeof input !== 'string' || input.length === 0) errors.push(path);
};

export const checkIsoTimestamp: Check = (input, path, errors) => {
  if (typeof input !== 'string' || !ISO_UTC.test(input) || !Number.isFinite(Date.parse(input))) {
    errors.push(path);
  }
};

/** Exact object: every listed key must be present and valid, no other key is allowed. */
export const checkObject =
  (shape: Record<string, Check>): Check =>
  (input, path, errors) => {
    if (!isPlainObject(input)) {
      errors.push(path);
      return;
    }
    for (const [key, check] of Object.entries(shape)) {
      if (!Object.hasOwn(input, key)) errors.push(`${path}.${key}`);
      else check(input[key], `${path}.${key}`, errors);
    }
    for (const key of Object.keys(input)) {
      if (!Object.hasOwn(shape, key)) errors.push(`${path}.${key}`);
    }
  };

export const checkServiceName = checkOneOf(SERVICE_NAMES);
export const checkHauntLevel = checkOneOf(HAUNT_LEVELS);
export const checkSignalKind = checkOneOf(SIGNAL_KINDS);

export const checkHauntReasonKind = checkOneOf(HAUNT_REASON_KINDS);

/** `null` or the given check. */
export const checkNullable =
  (inner: Check): Check =>
  (input, path, errors) => {
    if (input !== null) inner(input, path, errors);
  };

/** Array whose every element passes `inner`. */
export const checkArrayOf =
  (inner: Check): Check =>
  (input, path, errors) => {
    if (!Array.isArray(input)) {
      errors.push(path);
      return;
    }
    input.forEach((item, i) => inner(item, `${path}[${i}]`, errors));
  };
