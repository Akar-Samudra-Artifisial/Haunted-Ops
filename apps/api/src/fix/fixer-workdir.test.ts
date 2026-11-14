import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixerWorkdir, FixerWorkdirError, MAX_EXPORT_BYTES, exportPathsOf, readTar } from './fixer-workdir.js';
import { GitClient } from './git-client.js';
import { defaultFixerAgentSource } from './fix-env.js';
import { BROKEN_CHARGE, makeLabRepo, type LabRepo } from '../../test/support/lab-repo.js';

const ID = 'cmprop0000000000000000001';

/** A tar made by hand: one 512-byte header per entry, so the unsafe kinds can be written. */
function tarOf(entries: Array<{ name: string; type?: string; data?: string; link?: string; size?: number }>): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const h = Buffer.alloc(512);
    h.write(e.name.slice(0, 100), 0, 'utf8');
    h.write('0000644\0', 100, 'latin1');
    h.write(`${(e.size ?? data.length).toString(8).padStart(11, '0')}\0`, 124, 'latin1');
    h.write(e.type ?? '0', 156, 'latin1');
    if (e.link !== undefined) h.write(e.link, 157, 'utf8');
    h.write('ustar\0', 257, 'latin1');
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

describe('readTar', () => {
  const allowed = exportPathsOf('payments');

  it('reads plain files and folders of the allowed paths', () => {
    const entries = readTar(tarOf([{ name: 'services/', type: '5' }, { name: 'services/payments/', type: '5' }, { name: 'services/payments/src/a.js', data: 'x' }, { name: 'packages/lab-common/index.js', data: 'y' }]), allowed);
    expect(entries.map((e) => [e.path, e.type])).toEqual([['services', 'dir'], ['services/payments', 'dir'], ['services/payments/src/a.js', 'file'], ['packages/lab-common/index.js', 'file']]);
    expect(entries[2]?.data.toString()).toBe('x');
  });

  it('refuses links, devices, odd types, unsafe paths, paths outside the service and too much data', () => {
    const bad: Array<Parameters<typeof tarOf>[0]> = [
      [{ name: 'services/payments/src/l', type: '2', link: '/etc/passwd' }],
      [{ name: 'services/payments/src/h', type: '1', link: 'services/payments/src/a.js' }],
      [{ name: 'services/payments/src/dev', type: '3' }],
      [{ name: 'services/payments/src/fifo', type: '6' }],
      [{ name: '/etc/passwd', data: 'x' }],
      [{ name: 'services/payments/../../x', data: 'x' }],
      [{ name: 'services/payments/src/a\\b', data: 'x' }],
      [{ name: 'services/orders/src/a.js', data: 'x' }],
      [{ name: 'other/a.js', data: 'x' }],
      [{ name: 'services/payments/src/a.js', data: 'x', size: 99_999 }],
      [{ name: 'services/payments/src/big.js', data: 'x'.repeat(10), size: MAX_EXPORT_BYTES + 1 }],
    ];
    for (const entries of bad) expect(() => readTar(tarOf(entries), allowed), JSON.stringify(entries).slice(0, 80)).toThrow(FixerWorkdirError);
    expect(() => readTar(Buffer.from('garbage'.repeat(200)), allowed)).toThrow(FixerWorkdirError);
    expect(readTar(Buffer.alloc(0), allowed)).toEqual([]);
  });
});

describe('FixerWorkdir (an export from git archive of a local repository)', () => {
  let lab: LabRepo;
  let tmp: string;
  let root: string;
  let wd: FixerWorkdir;
  let tar: Buffer;

  beforeAll(async () => {
    lab = makeLabRepo();
    tmp = mkdtempSync(join(tmpdir(), 'fixer-workdir-'));
    root = join(tmp, 'fix');
    wd = new FixerWorkdir(root);
    await wd.prepareRoot();
    const git = new GitClient({ gitPath: '/usr/bin/git', repo: 'o/n', token: null, remoteUrl: () => `file://${lab.remote}`, allowFileProtocol: true, home: tmp });
    await git.ensureMirror(join(tmp, 'm.git'));
    tar = await git.archive(join(tmp, 'm.git'), lab.base, exportPathsOf('payments'));
  });
  afterAll(async () => {
    await wd.remove(ID);
    lab.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('is outside every git repository and holds no .git and no steering', async () => {
    const f = await wd.create(ID, 'payments', tar);
    for (const dir of [f.work, f.exportDir]) {
      let at = dir;
      for (;;) {
        expect(existsSync(join(at, '.git')), at).toBe(false);
        expect(existsSync(join(at, '.kiro', 'steering')), at).toBe(false);
        if (dirname(at) === at) break;
        at = dirname(at);
      }
    }
    expect(statSync(f.base).mode & 0o777).toBe(0o700);
  });

  it('holds only the files of the service, a read-only lab-common, the agent copy, and the export next to it', async () => {
    const f = await wd.create(ID, 'payments', tar);
    expect(await wd.fileList(f.work)).toEqual(['packages/lab-common/index.js', 'services/payments/package.json', 'services/payments/src/charge.js', 'services/payments/src/index.js', 'services/payments/test/charge.test.js']);
    expect(await wd.fileList(f.exportDir)).toEqual(await wd.fileList(f.work));
    expect(readFileSync(join(f.work, 'services/payments/src/charge.js'), 'utf8')).toBe(BROKEN_CHARGE);
    expect(existsSync(join(f.work, 'services/orders'))).toBe(false);
    // lab-common cannot be written, the service can.
    expect(statSync(join(f.work, 'packages/lab-common/index.js')).mode & 0o222).toBe(0);
    expect(() => writeFileSync(join(f.work, 'packages/lab-common/index.js'), 'x')).toThrow();
    expect(() => writeFileSync(join(f.work, 'packages/lab-common/new.js'), 'x')).toThrow();
    writeFileSync(join(f.work, 'services/payments/src/charge.js'), 'changed');
    expect(readFileSync(join(f.exportDir, 'services/payments/src/charge.js'), 'utf8')).toBe(BROKEN_CHARGE);
    // The agent copy is byte-equal, and a rewrite is noticed.
    expect(await wd.agentIntact(f.work)).toBe(true);
    expect(readFileSync(join(f.work, '.kiro/agents/exorcist-fixer.json'))).toEqual(readFileSync(defaultFixerAgentSource()));
    writeFileSync(join(f.work, '.kiro/agents/exorcist-fixer.json'), '{"changed":true}');
    expect(await wd.agentIntact(f.work)).toBe(false);
  });

  it('removes the folders of a run, read-only parts included, and a second removal is harmless', async () => {
    const f = await wd.create(ID, 'payments', tar);
    await wd.remove(ID);
    expect(existsSync(f.base)).toBe(false);
    await wd.remove(ID);
    expect(existsSync(join(root, 'fixer'))).toBe(true);
  });

  it('refuses a tar that holds a link or a path outside the service, and a proposal id that is not a CUID', async () => {
    await expect(wd.create(ID, 'payments', tarOf([{ name: 'services/payments/src/l', type: '2', link: '/etc/passwd' }]))).rejects.toMatchObject({ reason: 'export_unsafe' });
    await expect(wd.create(ID, 'payments', tarOf([{ name: 'services/orders/src/a.js', data: 'x' }]))).rejects.toMatchObject({ reason: 'export_unsafe' });
    for (const bad of ['../x', 'main', 'a b']) {
      expect(() => wd.folders(bad)).toThrow(FixerWorkdirError);
      expect(() => wd.pidPath(bad)).toThrow(FixerWorkdirError);
    }
    await expect(wd.create(ID, 'nginx' as never, tar)).rejects.toMatchObject({ reason: 'export_unsafe' });
  });

  it('gives the paths of the pid note, the mirror and the candidates inside its own root', () => {
    expect(wd.pidPath(ID)).toBe(join(wd.path, `${ID}.pid`));
    expect(wd.mirrorPath).toBe(join(wd.path, 'lab.git'));
    expect(wd.candidatePath(ID, 'patch')).toBe(join(wd.path, 'candidates', `${ID}-patch`));
    expect(() => wd.candidatePath(ID, '../x')).toThrow(FixerWorkdirError);
  });

  it('refuses a root inside a git repository or under a steering folder', async () => {
    const repo = join(tmp, 'a-repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    await expect(new FixerWorkdir(join(repo, 'x', 'y')).prepareRoot()).rejects.toMatchObject({ reason: 'inside_repository' });
    const steered = join(tmp, 'steered');
    mkdirSync(join(steered, '.kiro', 'steering'), { recursive: true });
    await expect(new FixerWorkdir(join(steered, 'x')).prepareRoot()).rejects.toMatchObject({ reason: 'has_steering' });
    // A real git repository is found too (and a worktree `.git` file).
    execFileSync('git', ['init', '--quiet', join(tmp, 'real')], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null' } });
    await expect(new FixerWorkdir(join(tmp, 'real', 'sub')).prepareRoot()).rejects.toMatchObject({ reason: 'inside_repository' });
    expect(lstatSync(join(tmp, 'real', '.git')).isDirectory()).toBe(true);
  });

  it('refuses when the agent file is missing', async () => {
    const other = new FixerWorkdir(join(tmp, 'other'), join(tmp, 'no-such-agent.json'));
    await other.prepareRoot();
    await expect(other.create(ID, 'payments', tar)).rejects.toMatchObject({ reason: 'bad_agent' });
    await other.remove(ID);
  });
});
