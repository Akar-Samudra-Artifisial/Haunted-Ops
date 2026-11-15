import { describe, expect, it } from 'vitest';
import { BASELINE_DETAIL_MAX, exclusionReason, exclusionText, firstErrorLine, selectSandboxGreen, type BaselineFileRun } from './test-baseline.js';

// Built from parts so that a scan of tracked files finds no home path here.
const HOME = ['', 'Users', 'someone'].join('/');
const run = (file: string, over: Partial<BaselineFileRun> = {}): BaselineFileRun => ({ file, ok: true, timedOut: false, messages: [], stderr: '', ...over });

describe('the sandbox-green set of a service', () => {
  it('keeps the files that pass at main and leaves the others out with a reason', () => {
    const set = selectSandboxGreen([
      run('services/payments/test/routes.test.ts', { ok: false, messages: ['Error: Test timed out in 5000ms.\nIf this is a long-running test, pass a timeout value'] }),
      run('services/payments/test/refunds.test.ts'),
      run('services/payments/test/b.test.ts', { ok: false, messages: ['AssertionError: expected 1 to be 2'] }),
      run('services/payments/test/a.test.ts'),
    ]);
    expect(set.included).toEqual(['services/payments/test/a.test.ts', 'services/payments/test/refunds.test.ts']);
    expect(set.excluded).toEqual([
      { file: 'services/payments/test/b.test.ts', reason: 'failed', detail: 'AssertionError: expected 1 to be 2' },
      { file: 'services/payments/test/routes.test.ts', reason: 'needs_network' },
    ]);
  });

  it('names the reason: a denied network call, a run that hit the timeout, a test timeout, anything else', () => {
    expect(exclusionReason(run('x', { ok: false, messages: ['Error: Access to this API has been restricted. Use --allow-net to manage permissions.'] }))).toBe('needs_network');
    expect(exclusionReason(run('x', { ok: false, stderr: 'Use --allow-net to manage permissions', timedOut: true }))).toBe('needs_network');
    expect(exclusionReason(run('x', { ok: false, timedOut: true }))).toBe('timeout');
    expect(exclusionReason(run('x', { ok: false, messages: ['Error: Test timed out in 5000ms.'] }))).toBe('needs_network');
    expect(exclusionReason(run('x', { ok: false, messages: ['Error: Access to this API has been restricted. Use --allow-fs-write to manage permissions.'] }))).toBe('failed');
    expect(exclusionReason(run('x', { ok: false }))).toBe('failed');
  });

  it('explains a failed file with its first error line: an import of a module outside the exported tree', () => {
    const set = selectSandboxGreen([
      run('services/orders/test/inventory.test.ts', {
        ok: false,
        messages: [`Error: Cannot find module '../../../scripts/scenario-copy.mjs' imported from ${HOME}/fix/candidates/x/services/orders/test/inventory.test.ts\n    at resolve (file://${HOME}/deps/node_modules/vite.js:1:1)`],
      }),
    ]);
    expect(set.included).toEqual([]);
    const [entry] = set.excluded;
    expect(entry?.reason).toBe('failed');
    expect(entry?.detail).toBe("Error: Cannot find module '../../../scripts/scenario-copy.mjs' imported from [path]");
    expect(entry?.detail).not.toContain(HOME);
    expect((entry?.detail ?? '').length).toBeLessThanOrEqual(BASELINE_DETAIL_MAX);
    expect(firstErrorLine(run('x', { ok: false, messages: ['', `  ${'y'.repeat(500)}`] }))).toHaveLength(BASELINE_DETAIL_MAX);
  });

  it('is empty when nothing passes, and empty for no file', () => {
    expect(selectSandboxGreen([run('a', { ok: false })]).included).toEqual([]);
    expect(selectSandboxGreen([])).toEqual({ included: [], excluded: [] });
  });

  it('words the reasons for the pull request', () => {
    expect(exclusionText('needs_network')).toBe('needs network');
    expect(exclusionText('timeout')).toBe('timed out at the base commit');
    expect(exclusionText('failed')).toBe('failed at the base commit');
    expect(exclusionText('not_at_base')).toBe('not at the base commit');
  });
});
