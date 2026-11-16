import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  REPLAY_FORBIDDEN,
  canonicalJson,
  hasHostName,
  hasIpv4,
  hasIpv6,
  replayForbiddenKind,
  replayHash,
  sha256Hex,
  validateReplayFile,
  type ReplayFile,
} from '../src/index.js';
import { goodReplay, huntDetail, proposalView, withReview } from './replay-fixture.js';
const bad = (file: unknown): string[] => {
  const r = validateReplayFile(file);
  return r.ok ? [] : r.errors;
};
describe('host names, addresses and markup', () => {
  /** Shapes that must pass: service and tool names, lab files, versions, numbers, times, prose. */
  const ACCEPTED = [
    'payments',
    'gate orders payments ledger',
    'query_metrics search_errors tail_logs recent_deploys diff_commit submit_diagnosis',
    'metrics payments error_ratio 15m',
    'payments/app.py',
    'edited services/payments/src/app.py and config.yaml',
    'README.md, package.json, pnpm-lock.yaml, app.test.ts, docker-compose.override.yml, refund_guard.py',
    'Node 26.1.0 and pnpm 11.7.0',
    'version 1.2.3, then 3.12.1.4.5',
    'payments/app.py',
    'app.py',
    'config.yaml',
    '1.2.3',
    '0.35',
    'v1.2.3.4 is a version, not an address',
    'error ratio 0.35 and p95 120.5ms',
    '2026-11-15T00:00:03.500Z',
    'at 12:30:45 and 10:00',
    'Done.Next sentence lost its space',
    'e.g. this, i.e. that, etc.',
    'the refund guard was removed (see commit 65c0fca31d0df62c4bab40d2d854c81b1044c650).',
    'listening on 127.0.0.1 only',
    'std::vector and Foo::bar',
    'a < b and b > c, 3 <= 4',
    'a -> b',
    'README.md, run.sh, test_app.py',
    'Done.Next',
    'std::vector and 12:30:45 and zab12fe80::1',
  ];
  for (const text of ACCEPTED) it(`accepts ${JSON.stringify(text)}`, () => expect(replayForbiddenKind(text)).toBeNull());
  /** Real host names, addresses and markup, in prose. */
  const REFUSED: Array<[string, string]> = [
    ['hostname', 'connect to staging.example.com now'],
    ['hostname', 'db1.corp'],
    ['hostname', 'host.local.'],
    ['hostname', 'ec2-1-2-3-4.compute-1.amazonaws.com'],
    ['hostname', 'API.EXAMPLE.ORG'],
    ['hostname', 'github.com'],
    ['hostname', '(payments.internal)'],
    ['hostname', 'staging.example.sh'],
    ['hostname', 'db.prod.md'],
    ['hostname', 'a.b.py'],
    ['hostname', 'example.Com'],
    ['hostname', 'Staging.Example.Com'],
    ['hostname', 'api.Example.IO'],
    ['ipv6 address', 'addr:fe80::1'],
    ['ipv6 address', 'ip:2001:db8::7'],
    ['ipv6 address', 'host=fe80::1'],
    ['ipv6 address', '[::1]'],
    ['bidi or zero-width character', 'a\u061Cb'],
    ['bidi or zero-width character', 'a\u2028b'],
    ['bidi or zero-width character', 'a\u2029b'],
    ['bidi or zero-width character', 'a\u2060b'],
    ['bidi or zero-width character', 'a\u2064b'],
    ['bidi or zero-width character', 'a\u{E0000}b'],
    ['bidi or zero-width character', 'a\u{E0041}b'],
    ['bidi or zero-width character', 'a\u{E007F}b'],
    ['ip address', 'from 10.1.2.3'],
    ['ip address', '192.168.0.1.'],
    ['ip address', 'a 255.255.255.255 b'],
    ['ip address', '0.0.0.0'],
    ['ipv6 address', 'localhost is ::1'],
    ['ipv6 address', '[::1]:8080'],
    ['ipv6 address', 'fe80::1ff:fe23:4567:890a'],
    ['ipv6 address', '2001:db8::8a2e:370:7334'],
    ['ipv6 address', '2001:0db8:0000:0000:0000:ff00:0042:8329'],
    ['ipv6 address', 'at ab:: end'],
    ['bidi or zero-width character', 'pay\u200Bments'],
    ['bidi or zero-width character', 'a\u200Eb'],
    ['bidi or zero-width character', 'a\u202Eb'],
    ['bidi or zero-width character', 'a\u2066b'],
    ['bidi or zero-width character', 'a\uFEFFb'],
    ['html tag', '<script>x</script>'],
    ['html tag', 'a </b> c'],
    ['html tag', '<!-- x -->'],
    ['url', 'see https://example.org/x'],
    ['url', 'HTTP://x'],
    ['root path', 'file /root/work'],
  ];
  for (const [kind, text] of REFUSED) {
    it(`refuses ${JSON.stringify(text)}`, () => {
      const found = replayForbiddenKind(text);
      expect(found).not.toBeNull();
      // The kind named is the first rule that matched; a link sample also holds a host name.
      if (kind !== 'url') expect(found).toBe(kind);
    });
  }
  it('takes an address only when each octet is 0 to 255 and the number stands alone', () => {
    expect(hasIpv4('1.2.3.255')).toBe(true);
    expect(hasIpv4('1.2.3.256')).toBe(false);
    expect(hasIpv4('1234.1.1.1')).toBe(false);
    expect(hasIpv4('1.2.3.4.5')).toBe(false);
    expect(hasIpv4('x1.2.3.4')).toBe(false);
    expect(hasIpv4('v1.2.3.4')).toBe(false);
    expect(hasIpv4('.1.2.3.4')).toBe(false);
    expect(hasIpv4('(1.2.3.4)')).toBe(true);
    expect(hasIpv4('127.0.0.1')).toBe(false);
    expect(hasIpv4('127.0.0.10')).toBe(true);
  });
  it('knows an IPv6 address by its groups', () => {
    for (const ok of ['::1', 'fe80::1', '1::', '::ffff:1:2', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7::']) expect(hasIpv6(ok), ok).toBe(true);
    for (const no of ['::', '12:30:45', '1:2:3:4:5:6:7', '1::2::3', ':::1', 'a:b:c:d:e:f:1:2:3', 'std::vector', 'x::1', '1:2:3:4:5:6:7:8:', 'zab12fe80::1', 'time:12:30:45']) expect(hasIpv6(no), no).toBe(false);
    for (const ok of ['addr:fe80::1', 'ip:2001:db8::7', 'host=fe80::1', '[::1]']) expect(hasIpv6(ok), ok).toBe(true);
  });
  it('allows a link only as the prUrl of the lab, and names the path of any other link', () => {
    expect(validateReplayFile(withReview(goodReplay())).ok).toBe(true);
    const g = structuredClone(goodReplay());
    (g.frames[2] as { hunt: unknown }).hunt = { ...huntDetail, fixHint: 'see https://github.com/Akar-Samudra-Artifisial/Haunted-Lab/pull/7' };
    expect(bad(g)).toContain('$.frames[2].hunt.fixHint');
    // A pull request of another repository fails its own check.
    const other = structuredClone(goodReplay());
    (other.frames[3] as { proposal: unknown }).proposal = { ...proposalView, prUrl: 'https://github.com/someone/else/pull/1' };
    expect(bad(other).some((p) => p.endsWith('.prUrl'))).toBe(true);
  });
  it('reads a 64 KiB adversarial text of every shape in under 200 ms, and a file of such strings too', () => {
    const size = 64 * 1024;
    const shapes = [
      'a'.repeat(size),
      '-'.repeat(size),
      `a${'-'.repeat(size)}a`,
      `a${'.'.repeat(size)}`,
      'a.'.repeat(size / 2),
      'a@'.repeat(size / 2),
      `a@${'b'.repeat(size)}`,
      'a@b.'.repeat(size / 4),
      ':'.repeat(size),
      '::1'.repeat(size / 3),
      'a:'.repeat(size / 2),
      '1.'.repeat(size / 2),
      '1.2.3.'.repeat(size / 6),
      ' '.repeat(size),
      `Bearer${' '.repeat(size)}`,
      'Bearer '.repeat(size / 7),
      'sk-'.repeat(size / 3),
      'ghp_'.repeat(size / 4),
      '/Users/'.repeat(size / 7),
      '<'.repeat(size),
      'http'.repeat(size / 4),
      '9'.repeat(size),
      ':a'.repeat(size / 2),
      'a.b.py.'.repeat(size / 7),
      'a.Com.'.repeat(size / 6),
    ];
    for (const shape of shapes) {
      const started = performance.now();
      for (const f of REPLAY_FORBIDDEN) f.test(shape);
      expect(performance.now() - started, shape.slice(0, 8)).toBeLessThan(200);
    }
    // The same inside a file: 64 steps of 1000 characters (about 64 KiB of text).
    for (const shape of ['a@'.repeat(500), `a${'-'.repeat(998)}a`, 'a.'.repeat(500), '::1'.repeat(333)]) {
      const f = structuredClone(goodReplay());
      (f.frames[2] as { hunt: unknown }).hunt = {
        ...huntDetail,
        allSteps: Array.from({ length: 64 }, (_, i) => ({ ...huntDetail.allSteps[0], index: i + 1, summary: shape })),
      };
      const started = performance.now();
      validateReplayFile(f);
      expect(performance.now() - started, shape.slice(0, 8)).toBeLessThan(200);
    }
  });
  it('hasHostName reads the last two labels of a name', () => {
    expect(hasHostName('a.b')).toBe(false);
    expect(hasHostName('a.bc')).toBe(true);
    expect(hasHostName('a.b.cd')).toBe(true);
    expect(hasHostName('1.2.cd')).toBe(true);
    expect(hasHostName('x..cd')).toBe(false);
  });
});
describe('sha256 and canonical JSON', () => {
  const node = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
  it('gives the same hash as node:crypto, also at the block edges and for multi-byte text', () => {
    const texts = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(65), 'é'.repeat(100), '日本語 😀 text', 'a\u0000b', 'x'.repeat(100_000)];
    for (const t of texts) expect(sha256Hex(t), t.slice(0, 8)).toBe(node(t));
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('sorts keys, drops undefined and keeps arrays in order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null }, u: undefined })).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
    expect(canonicalJson([undefined, 'é'])).toBe('[null,"é"]');
  });
  it('the hash of a file does not depend on the order of its keys', () => {
    const reviewed: ReplayFile = withReview(goodReplay());
    const shuffled = Object.fromEntries(Object.entries(reviewed).reverse());
    expect(validateReplayFile(shuffled).ok).toBe(true);
    expect(replayHash(reviewed)).toBe(replayHash(shuffled));
  });
});
