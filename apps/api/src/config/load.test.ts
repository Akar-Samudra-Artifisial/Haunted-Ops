import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfigOrExit } from './load.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadConfigOrExit', () => {
  it('prints names only and exits 1 on invalid config', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit called');
    }) as never);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => loadConfigOrExit({ DATABASE_URL: 'mysql://user:pa55word-xyz@h/db', PORT: '3000' })).toThrow('exit called');
    expect(exit).toHaveBeenCalledWith(1);
    const printed = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toBe('Invalid configuration: DATABASE_URL, WEB_ORIGIN\n');
    expect(printed).not.toContain('pa55word');
  });

  it('returns the config when valid', () => {
    const cfg = loadConfigOrExit({
      DATABASE_URL: 'postgres://app@localhost/haunted_dev',
      PORT: '3000',
      WEB_ORIGIN: 'http://localhost:5173',
    });
    expect(cfg.port).toBe(3000);
  });
});
