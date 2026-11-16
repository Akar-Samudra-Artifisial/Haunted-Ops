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
    // Code names: a well-known code object and an identifier (replay task 12).
    'run the warehouse freshness checks in parallel (Promise.all)',
    'Promise.allSettled, Array.from(x), Object.keys, JSON.parse and Math.max',
    'fs.readFile, path.join, os.path, process.env, console.log, res.send and req.body',
    'this.state, window.location, document.title, prisma.user, ctx.state, router.get',
    'Buffer.from then Number.isInteger then String.raw.',
    // A second label that is not a host ending stays code (replay task 13).
    'Promise.all',
    'Array.from',
    'Object.keys',
    'fs.readFile',
    'res.json',
    'Date.now',
    'JSON.parse',
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
    ['hostname', 'promise.all.example.com'],
    ['hostname', 'Promise.all.com'],
    ['hostname', 'console.kaktua.com'],
    ['hostname', 'process.example.org'],
    ['hostname', 'Promise.example.com'],
    ['hostname', 'www.Promise.all'],
    ['hostname', 'promise.all'],
    ['hostname', 'Foo.bar'],
    // A code object with a host ending as its second label is a host name (replay task 13).
    ['hostname', 'fs.internal'],
    ['hostname', 'app.corp'],
    ['hostname', 'res.dev'],
    ['hostname', 'prisma.io'],
    ['hostname', 'crypto.com'],
    ['hostname', 'Date.com'],
    ['hostname', 'console.IO'],
    ['hostname', 'path.Local'],
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
  /**
   * Linear time, measured as growth and not as wall-clock time (a busy machine makes every run slower, not steeper): for each
   * adversarial shape, the minimum time per call at 128 KiB divided by the minimum at 16 KiB is at most 20 (linear is about 8,
   * quadratic about 64). Each sample repeats the call until 20 ms of wall time have passed and records the CPU time of the thread
   * per call (`process.threadCpuUsage`), so neither a clock tick nor the time the thread waits for a core on a busy machine is in
   * it; the minimum of 7 samples per size (after one warm-up) is the run with the least interference (a median is not), and the
   * samples of the two sizes alternate so that a slow stretch of the machine falls on both. One generous ceiling of 2 s per call
   * at 128 KiB only guards against a hang.
   */
  const SMALL = 16 * 1024;
  const LARGE = 128 * 1024;
  const SAMPLES = 7;
  const SAMPLE_MS = 20;
  const CEILING_MS = 2000;
  let largestRatio = 0;
  /** CPU time of this thread in ms: time spent waiting for a core (other processes) is not in it. */
  const cpuMs = (): number => {
    const used = process.threadCpuUsage();
    return (used.user + used.system) / 1000;
  };
  /** The time per call of one sample: the call repeated until `SAMPLE_MS` of wall time have passed, as CPU time of the thread per call. */
  const sampleMs = (run: () => void): number => {
    let calls = 0;
    const started = performance.now();
    const cpu = cpuMs();
    do {
      run();
      calls++;
    } while (performance.now() - started < SAMPLE_MS);
    return (cpuMs() - cpu) / calls;
  };
  const expectLinear = (label: string, small: () => void, large: () => void): void => {
    small(); // warm-up
    large();
    // The samples of the two sizes alternate, so a slow stretch of the machine (another process, a slower core) falls on both.
    let s = Infinity;
    let l = Infinity;
    for (let i = 0; i < SAMPLES; i++) {
      s = Math.min(s, sampleMs(small));
      l = Math.min(l, sampleMs(large));
    }
    largestRatio = Math.max(largestRatio, l / s);
    if (process.env.TIMING_REPORT === 'all') process.stderr.write(`[timing] ${label}: ${s.toFixed(3)} ms to ${l.toFixed(3)} ms, ratio ${(l / s).toFixed(2)}\n`);
    expect(l, `${label}: ceiling`).toBeLessThan(CEILING_MS);
    expect(l / s, `${label}: growth for 8x the text (${s.toFixed(3)} ms to ${l.toFixed(3)} ms)`).toBeLessThanOrEqual(20);
  };
  it('reads a 128 KiB adversarial text of every shape in linear time, and a file of such strings too', () => {
    const shapes: Array<[string, (size: number) => string]> = [
      ['a', (n) => 'a'.repeat(n)],
      ['-', (n) => '-'.repeat(n)],
      ['a-..-a', (n) => `a${'-'.repeat(n)}a`],
      ['a....', (n) => `a${'.'.repeat(n)}`],
      ['a.a.', (n) => 'a.'.repeat(n / 2)],
      ['a@a@', (n) => 'a@'.repeat(n / 2)],
      ['a@bbb', (n) => `a@${'b'.repeat(n)}`],
      ['a@b.', (n) => 'a@b.'.repeat(n / 4)],
      [':', (n) => ':'.repeat(n)],
      ['::1', (n) => '::1'.repeat(n / 3)],
      ['a:', (n) => 'a:'.repeat(n / 2)],
      ['1.', (n) => '1.'.repeat(n / 2)],
      ['1.2.3.', (n) => '1.2.3.'.repeat(n / 6)],
      ['spaces', (n) => ' '.repeat(n)],
      ['Bearer+spaces', (n) => `Bearer${' '.repeat(n)}`],
      ['Bearer ', (n) => 'Bearer '.repeat(n / 7)],
      ['sk-', (n) => 'sk-'.repeat(n / 3)],
      ['ghp_', (n) => 'ghp_'.repeat(n / 4)],
      ['/Users/', (n) => '/Users/'.repeat(n / 7)],
      ['<', (n) => '<'.repeat(n)],
      ['http', (n) => 'http'.repeat(n / 4)],
      ['9', (n) => '9'.repeat(n)],
      [':a', (n) => ':a'.repeat(n / 2)],
      ['a.b.py.', (n) => 'a.b.py.'.repeat(n / 7)],
      ['a.Com.', (n) => 'a.Com.'.repeat(n / 6)],
      ['Promise.all.', (n) => 'Promise.all.'.repeat(n / 12)],
      ['fs.readFile ', (n) => 'fs.readFile '.repeat(n / 12)],
      ['2026-11-15T12:00:00Z ', (n) => '2026-11-15T12:00:00Z '.repeat(n / 21)],
    ];
    for (const [label, make] of shapes) {
      const small = make(SMALL);
      const large = make(LARGE);
      const readAll = (text: string) => () => {
        for (const f of REPLAY_FORBIDDEN) f.test(text);
      };
      expectLinear(label, readAll(small), readAll(large));
    }
    // The same inside a file: 16 and 128 steps of 1000 characters (about 128 KiB of text at the large size).
    for (const shape of ['a@'.repeat(500), `a${'-'.repeat(998)}a`, 'a.'.repeat(500), '::1'.repeat(333)]) {
      const fileOf = (steps: number): ReplayFile => {
        const f = structuredClone(goodReplay());
        (f.frames[2] as { hunt: unknown }).hunt = {
          ...huntDetail,
          allSteps: Array.from({ length: steps }, (_, i) => ({ ...huntDetail.allSteps[0], index: i + 1, summary: shape })),
        };
        return f;
      };
      const small = fileOf(16);
      const large = fileOf(128);
      expectLinear(`file of ${shape.slice(0, 8)}`, () => void validateReplayFile(small), () => void validateReplayFile(large));
    }
    if (process.env.TIMING_REPORT !== undefined) process.stderr.write(`[timing] largest growth ratio ${largestRatio.toFixed(2)}\n`);
  }, 60_000);
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
