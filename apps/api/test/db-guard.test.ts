import { describe, expect, it } from 'vitest';
import { REFUSE_MESSAGE, RefuseToRunError, dbGuard } from './db-guard.js';

describe('dbGuard', () => {
  it('skips when TEST_DATABASE_URL is unset or blank', () => {
    expect(dbGuard({})).toEqual({ run: false, reason: 'unset' });
    expect(dbGuard({ TEST_DATABASE_URL: '  ' })).toEqual({ run: false, reason: 'unset' });
  });

  it('refuses when TEST_DATABASE_URL equals DATABASE_URL', () => {
    const url = 'postgresql://app@localhost:5432/haunted_dev';
    expect(() => dbGuard({ TEST_DATABASE_URL: url, DATABASE_URL: url })).toThrow(RefuseToRunError);
    expect(() => dbGuard({ TEST_DATABASE_URL: url, DATABASE_URL: url })).toThrow(REFUSE_MESSAGE);
  });

  it('runs against a separate Test database', () => {
    expect(
      dbGuard({
        TEST_DATABASE_URL: 'postgresql://app@localhost:5432/haunted_test',
        DATABASE_URL: 'postgresql://app@localhost:5432/haunted_dev',
      }),
    ).toEqual({ run: true, url: 'postgresql://app@localhost:5432/haunted_test' });
  });
});
