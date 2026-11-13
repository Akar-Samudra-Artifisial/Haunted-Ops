import { describe, expect, it } from 'vitest';
import { formatConfigError, isAllowedOrigin, parseMcpConfig } from '../src/config.js';

const ID = 'cmhuntaaaaaaaaaaaaaaaaaaa';
const good = {
  LAB_URL: 'http://127.0.0.1:4100',
  LAB_READ_TOKEN: 'a-long-enough-lab-token',
  PROMETHEUS_URL: 'http://localhost:9090/',
  HUNT_ID: ID,
  HUNT_LEDGER_PATH: `/tmp/haunted-ops-hunts/ledgers/${ID}.jsonl`,
};

describe('parseMcpConfig', () => {
  it('accepts loopback backends and normalises them to origins', () => {
    const r = parseMcpConfig(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config).toMatchObject({ labUrl: 'http://127.0.0.1:4100', promUrl: 'http://localhost:9090' });
    expect(parseMcpConfig({ ...good, LAB_URL: undefined, PROMETHEUS_URL: '' }).ok).toBe(true);
  });

  it('refuses remote hosts unless allowed, and link-local hosts always', () => {
    expect(parseMcpConfig({ ...good, LAB_URL: 'http://lab.internal:4100' })).toEqual({ ok: false, names: ['LAB_URL'] });
    expect(parseMcpConfig({ ...good, LAB_URL: 'http://lab.internal:4100', LAB_ALLOW_REMOTE: 'true' }).ok).toBe(true);
    expect(parseMcpConfig({ ...good, PROMETHEUS_URL: 'http://169.254.169.254', PROMETHEUS_ALLOW_REMOTE: 'true' })).toEqual({ ok: false, names: ['PROMETHEUS_URL'] });
    expect(isAllowedOrigin('http://[fe80::1]:80', true)).toBe(false);
    expect(isAllowedOrigin('http://[::1]:4100', false)).toBe(true);
    expect(isAllowedOrigin('http://user:pw@127.0.0.1:4100', false)).toBe(false);
    expect(isAllowedOrigin('http://127.0.0.1:4100/lab', false)).toBe(false);
    expect(isAllowedOrigin('file:///etc/passwd', true)).toBe(false);
    expect(parseMcpConfig({ ...good, LAB_ALLOW_REMOTE: 'yes' })).toEqual({ ok: false, names: ['LAB_ALLOW_REMOTE'] });
  });

  it('checks the token, the hunt id and the ledger path, naming variables and never values', () => {
    const r = parseMcpConfig({ ...good, LAB_READ_TOKEN: 'short', HUNT_ID: 'Bad Id', HUNT_LEDGER_PATH: 'ledger.jsonl' });
    expect(r).toEqual({ ok: false, names: ['LAB_READ_TOKEN', 'HUNT_ID', 'HUNT_LEDGER_PATH'] });
    expect(parseMcpConfig({ ...good, HUNT_LEDGER_PATH: `/tmp/x/../ledgers/${ID}.jsonl` }).ok).toBe(false);
    expect(parseMcpConfig({ ...good, HUNT_LEDGER_PATH: `/tmp/ledgers/other.jsonl` }).ok).toBe(false);
    const msg = formatConfigError(['LAB_READ_TOKEN']);
    expect(msg).toBe('invalid env: LAB_READ_TOKEN');
    expect(msg).not.toContain(good.LAB_READ_TOKEN);
  });
});
