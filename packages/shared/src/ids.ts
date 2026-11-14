import type { Check } from './checks.js';

/** Ids of rows made by Prisma (`cuid()`). */
export const CUID_PATTERN = /^[a-z0-9]{20,32}$/;

export const checkCuid: Check = (input, path, errors) => {
  if (typeof input !== 'string' || !CUID_PATTERN.test(input)) errors.push(path);
};
