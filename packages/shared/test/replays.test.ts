import { describe, expect, it } from 'vitest';
import {
  REPLAY_FORBIDDEN,
  REPLAY_LIMITS,
  applyReplayFrame,
  replayHash,
  replayReviewHash,
  replayForbiddenKind,
  replayListItem,
  validateReplayFile,
  type ReplayFile,
} from '../src/index.js';
import { goodReplay, huntDetail, proposalView, services, withReview } from './replay-fixture.js';
const bad = (file: unknown): string[] => {
  const r = validateReplayFile(file);
  return r.ok ? [] : r.errors;
};
const clone = (): ReplayFile => structuredClone(goodReplay());
describe('validateReplayFile', () => {
  it('accepts a good file, reviewed or not', () => {
    expect(validateReplayFile(goodReplay()).ok).toBe(true);
    expect(validateReplayFile(withReview(goodReplay())).ok).toBe(true);
  });
  it('is total: any input gives a result', () => {
    for (const v of [null, undefined, 1, 'x', [], {}, { frames: 1 }]) expect(validateReplayFile(v).ok).toBe(false);
  });
  it('checks the id at its edges', () => {
    for (const id of ['abc', 'a-c', '0bc', `a${'b'.repeat(47)}`]) expect(validateReplayFile({ ...goodReplay(), id }).ok).toBe(true);
    for (const id of ['ab', '-bc', 'Abc', 'a_c', `a${'b'.repeat(48)}`, '', 7]) expect(bad({ ...goodReplay(), id })).toContain('$.id');
  });
  it('checks the title at its edges: 1 to 80 characters, one line', () => {
    expect(validateReplayFile({ ...goodReplay(), title: 'x' }).ok).toBe(true);
    expect(validateReplayFile({ ...goodReplay(), title: 'x '.repeat(40) }).ok).toBe(true);
    expect(bad({ ...goodReplay(), title: '' })).toContain('$.title');
    expect(bad({ ...goodReplay(), title: 'x '.repeat(40) + 'x' })).toContain('$.title');
    expect(bad({ ...goodReplay(), title: 'a\nb' })).toContain('$.title');
  });
  it('checks the scenario and the recording date', () => {
    expect(bad({ ...goodReplay(), scenario: 'flood' })).toContain('$.scenario');
    for (const recordedOn of ['2026-11-15T10:00:00Z', '2026-13-01', '2026-02-30', '15-11-2026', 20261115]) {
      expect(bad({ ...goodReplay(), recordedOn })).toContain('$.recordedOn');
    }
  });
  it('checks durationMs at its edges: an integer from 1 to 900000', () => {
    const f = clone();
    f.frames = [f.frames[0] as ReplayFile['frames'][number]];
    expect(validateReplayFile({ ...f, durationMs: 1 }).ok).toBe(true);
    expect(validateReplayFile({ ...f, durationMs: 900_000 }).ok).toBe(true);
    for (const durationMs of [0, -1, 900_001, 1.5, '5']) expect(bad({ ...f, durationMs })).toContain('$.durationMs');
  });
  it('checks the review: null or a date, 2 to 4 initials, a note of at most 200 characters and the hash of the file', () => {
    const ok = { reviewedOn: '2026-11-16', by: 'AB', note: '', sha256: replayReviewHash(goodReplay()) };
    expect(validateReplayFile({ ...goodReplay(), review: ok }).ok).toBe(true);
    expect(validateReplayFile({ ...goodReplay(), review: { ...ok, by: 'ABCD', note: 'x '.repeat(100) } }).ok).toBe(true);
    expect(bad({ ...goodReplay(), review: { ...ok, by: 'A' } })).toContain('$.review.by');
    expect(bad({ ...goodReplay(), review: { ...ok, by: 'ABCDE' } })).toContain('$.review.by');
    expect(bad({ ...goodReplay(), review: { ...ok, by: 'A1' } })).toContain('$.review.by');
    expect(bad({ ...goodReplay(), review: { ...ok, note: 'x '.repeat(100) + 'x' } })).toContain('$.review.note');
    expect(bad({ ...goodReplay(), review: { ...ok, reviewedOn: '2026-11-16T00:00:00Z' } })).toContain('$.review.reviewedOn');
    expect(bad({ ...goodReplay(), review: { ...ok, extra: 1 } })).toContain('$.review.extra');
    expect(bad({ ...goodReplay(), review: 'yes' })).toContain('$.review');
  });
  it('binds the review to the content: no hash, a malformed hash, a hash of another file or an edit after the review fails', () => {
    const reviewed = withReview(goodReplay());
    expect(validateReplayFile(reviewed).ok).toBe(true);
    const { sha256: _hash, ...noHash } = reviewed.review as NonNullable<ReplayFile['review']>;
    expect(bad({ ...reviewed, review: noHash })).toContain('$.review.sha256');
    for (const sha256 of ['', 'abc', 'A'.repeat(64), 7, null, 'a'.repeat(63), 'a'.repeat(65)]) expect(bad({ ...reviewed, review: { ...noHash, sha256 } })).toContain('$.review.sha256');
    // The hash of a different file, and the file edited after it was read.
    const other = withReview({ ...goodReplay(), title: 'Another title' });
    expect(bad({ ...reviewed, review: other.review })).toContain('$.review.sha256');
    expect(bad({ ...reviewed, title: 'Edited after the review' })).toContain('$.review.sha256');
    const edited = structuredClone(reviewed);
    (edited.frames[1] as { t: number }).t = 2001;
    expect(bad(edited)).toContain('$.review.sha256');
    // The note and the date of the review are not part of the bound content.
    expect(validateReplayFile({ ...reviewed, review: { ...(reviewed.review as object), note: 'A new note' } }).ok).toBe(true);
    expect(replayHash(reviewed)).not.toBe(replayHash(goodReplay()));
  });
  it('checks the number of frames: 1 to 400', () => {
    const first = goodReplay().frames[0] as ReplayFile['frames'][number];
    const many = (n: number): ReplayFile => ({ ...goodReplay(), durationMs: 900_000, frames: Array.from({ length: n }, (_, i) => (i === 0 ? first : { t: i * 1000 })) });
    expect(validateReplayFile(many(1)).ok).toBe(true);
    expect(validateReplayFile(many(400)).ok).toBe(true);
    expect(bad(many(401))).toContain('$.frames');
    expect(bad({ ...goodReplay(), frames: [] })).toContain('$.frames');
  });
  it('wants t to be an integer, 0 first, not decreasing and not after durationMs', () => {
    const f = clone();
    const set = (ts: number[]): ReplayFile => ({ ...f, frames: ts.map((t, i) => (i === 0 ? { ...(f.frames[0] as object), t } : { t })) as ReplayFile['frames'] });
    expect(validateReplayFile(set([0, 5000, 5000, 10_000])).ok).toBe(true);
    expect(bad(set([0, 5000, 4999]))).toContain('$.frames[2].t');
    expect(bad(set([1, 5000]))).toContain('$.frames[0].t');
    expect(bad(set([0, 10_001]))).toContain('$.frames[1].t');
    expect(bad(set([0, 1.5]))).toContain('$.frames[1].t');
    expect(bad(set([0, -1]))).toContain('$.frames[1].t');
  });
  it('wants services in the first frame, all four in room order', () => {
    const f = clone();
    delete (f.frames[0] as { services?: unknown }).services;
    expect(bad(f)).toContain('$.frames[0].services');
    const short = clone();
    (short.frames[1] as { services: unknown }).services = services().slice(0, 3);
    expect(bad(short)).toContain('$.frames[1].services');
    const swapped = clone();
    (swapped.frames[1] as { services: unknown }).services = [...services()].reverse();
    expect(bad(swapped).some((p) => p.startsWith('$.frames[1].services'))).toBe(true);
  });
  it('rejects an unknown key at the top, in a frame and in the review', () => {
    expect(bad({ ...goodReplay(), extra: 1 })).toContain('$.extra');
    const f = clone();
    (f.frames[1] as object as Record<string, unknown>).extra = 1;
    expect(bad(f)).toContain('$.frames[1].extra');
    expect(bad({ ...goodReplay(), version: 2 })).toContain('$.version');
    const missing: Record<string, unknown> = { ...goodReplay() };
    delete missing.scenario;
    expect(bad(missing)).toContain('$.scenario');
  });
  it('validates the parts with the existing validators', () => {
    const f = clone();
    (f.frames[2] as { hunt: unknown }).hunt = { ...huntDetail, status: 'busy' };
    expect(bad(f).some((p) => p.startsWith('$.frames[2].hunt'))).toBe(true);
    const g = clone();
    (g.frames[3] as { proposal: unknown }).proposal = { ...proposalView, status: 'busy' };
    expect(bad(g).some((p) => p.startsWith('$.frames[3].proposal'))).toBe(true);
  });
  it('accepts only the pull request URL of the lab repository', () => {
    for (const prUrl of ['https://github.com/other-org/Haunted-Lab/pull/7', 'https://github.com/Akar-Samudra-Artifisial/Other/pull/7', 'http://github.com/Akar-Samudra-Artifisial/Haunted-Lab/pull/7']) {
      const f = clone();
      (f.frames[3] as { proposal: unknown }).proposal = { ...proposalView, prUrl };
      expect(bad(f)).toContain('$.frames[3].proposal.prUrl');
      const g = clone();
      (g.frames[3] as { services: unknown }).services = services(4, null, { ...proposalView, prUrl });
      expect(bad(g)).toContain('$.frames[3].services[2].proposal.prUrl');
      const h = clone();
      (h.frames[2] as { hunt: unknown }).hunt = { ...huntDetail, proposal: { ...proposalView, prUrl } };
      expect(bad(h).length).toBeGreaterThan(0);
    }
  });
  it('is at most 256 KiB as UTF-8 JSON, counted in bytes', () => {
    const bytes = (f: unknown): number => new TextEncoder().encode(JSON.stringify(f)).length;
    const frameOf = (evidence: number, fixHint: string, filler: string) => ({
      t: 1000,
      hunt: { ...huntDetail, fixHint, evidence: Array.from({ length: evidence }, (_, k) => ({ index: k + 1, kind: 'log' as const, ref: `log:${k}`, detail: filler.repeat(100), cited: false })) },
    });
    // A file of exactly `size` bytes: full frames, then one frame whose fixHint (ASCII) tunes the last bytes.
    const build = (size: number, filler: string): ReplayFile => {
      const f = clone();
      f.durationMs = 900_000;
      f.frames = [f.frames[0] as ReplayFile['frames'][number]];
      while (bytes(f) + bytes(frameOf(40, '', filler)) + 1 < size) f.frames.push(frameOf(40, '', filler));
      for (let e = 40; e >= 0; e--) {
        const probe = { ...f, frames: [...f.frames, frameOf(e, '', filler)] };
        const need = size - bytes(probe);
        if (need >= 0 && need <= 300) {
          probe.frames[probe.frames.length - 1] = frameOf(e, `${'a '.repeat(Math.floor(need / 2))}${need % 2 === 1 ? 'a' : ''}`, filler);
          expect(bytes(probe)).toBe(size);
          return probe;
        }
      }
      throw new Error('cannot size the file');
    };
    for (const filler of ['a ', 'é ']) {
      expect(validateReplayFile(build(REPLAY_LIMITS.bytes, filler)).ok).toBe(true);
      expect(bad(build(REPLAY_LIMITS.bytes + 1, filler))).toContain('$');
    }
    // 'é ' is 3 bytes for 2 characters: the same character count gives more bytes.
    expect(bytes(frameOf(1, '', 'é '))).toBeGreaterThan(bytes(frameOf(1, '', 'a ')));
  });
});
describe('forbidden strings', () => {
  const samples: Record<string, string> = {
    'bearer value': 'Authorization: Bearer abcdefgh12345678',
    'email address': 'ask someone@example.com now',
    'home path': 'in /Users/someone/project',
    'temp path': 'at /tmp/work/file',
    'windows path': 'C:\\Users\\someone\\x',
    'github token': `token ghp_${'a'.repeat(20)}`,
    'aws key id': `key AKIA${'A'.repeat(14)}`,
    'api key': `sk-${'a'.repeat(20)}`,
    'private key': '-----BEGIN RSA PRIVATE KEY-----',
    uuid: '123e4567-e89b-12d3-a456-426614174000',
    'account id': 'account 123456789012 here',
    'ip address': 'from 10.1.2.3 today',
    'ipv6 address': 'from fe80::1 today',
    hostname: 'host staging.example.com reached',
    url: 'see http://example.test/x',
    'html tag': 'a <b>bold</b> claim',
    'bidi or zero-width character': 'pay\u200Bments',
    'root path': 'in /root/work',
    'control character': 'a\u001b[31mred',
  };
  it('has one sample for every kind', () => {
    expect(Object.keys(samples).sort()).toEqual(REPLAY_FORBIDDEN.map((f) => f.name).sort());
  });
  for (const [kind, text] of Object.entries(samples)) {
    it(`finds ${kind} in a step summary, a title and a review note and names only the path`, () => {
      expect(replayForbiddenKind(text)).not.toBeNull();
      const f = clone();
      (f.frames[2] as { hunt: { allSteps: Array<{ summary: string }> } }).hunt = { ...huntDetail, allSteps: [{ ...huntDetail.allSteps[0], summary: text }] } as never;
      const errors = bad(f);
      expect(errors.some((p) => p.startsWith('$.frames[2].hunt.allSteps[0].summary'))).toBe(true);
      expect(errors.join(' ')).not.toContain(text);
      expect(bad({ ...goodReplay(), title: text.replace(/\n/g, ' ') }).length).toBeGreaterThan(0);
      expect(bad(withReview(goodReplay(), { note: text }))).toContain('$.review.note');
    });
  }
  it('lets a commit SHA of 40 hex characters and plain prose through', () => {
    expect(replayForbiddenKind('commit 65c0fca31d0df62c4bab40d2d854c81b1044c650 removed the guard')).toBeNull();
    expect(replayForbiddenKind('Line one\nline two. 127.0.0.1 is local.')).toBeNull();
    expect(replayForbiddenKind('a'.repeat(31))).toBeNull();
    expect(replayForbiddenKind('a'.repeat(32))).toBe('token shape');
    expect(replayForbiddenKind('x'.repeat(1001))).toBe('long string');
  });
  it('allows the line feed only, in a text that may have one', () => {
    const f = clone();
    (f.frames[2] as { hunt: { fixHint: string } }).hunt = { ...huntDetail, fixHint: 'one\ntwo' } as never;
    expect(validateReplayFile(f).ok).toBe(true);
    (f.frames[2] as { hunt: { fixHint: string } }).hunt = { ...huntDetail, fixHint: 'one\ttwo' } as never;
    expect(validateReplayFile(f).ok).toBe(false);
  });
});
describe('helpers', () => {
  it('lists a file without its frames', () => {
    expect(replayListItem(goodReplay())).toEqual({ id: 'good-replay', title: 'Synthetic: payments goes dark', scenario: 'dark-room', recordedOn: '2026-11-15', durationMs: 10_000 });
  });
  it('applies a frame: each part it names replaces that part', () => {
    const s0 = { services: services(0), hunt: null, proposal: null };
    const s1 = applyReplayFrame(s0, { t: 1, hunt: huntDetail });
    expect(s1.hunt).toBe(huntDetail);
    expect(s1.services).toBe(s0.services);
    const s2 = applyReplayFrame(s1, { t: 2, hunt: null, proposal: proposalView });
    expect(s2.hunt).toBeNull();
    expect(s2.proposal).toBe(proposalView);
  });
});
