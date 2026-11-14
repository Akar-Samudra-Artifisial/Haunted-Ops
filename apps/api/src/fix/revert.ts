import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProposalCheck, ServiceName } from '@haunted-ops/shared';
import type { GitClient } from './git-client.js';
import { MAX_PATCH_FILE_BYTES, type TestsResult } from './patch-checks.js';

export type RevertUnavailable = 'revert_unavailable' | 'revert_conflict';

export type RevertAttempt =
  | { ok: true; files: string[]; head: string }
  | { ok: false; reason: RevertUnavailable };

/**
 * `git revert --no-edit C` on top of D in a clone that is at D. It is used only when C is a commit with one parent
 * (a merge commit has no single revert), an ancestor of D, and the revert applies cleanly. The commit message is
 * replaced by `message`, so every fix commit looks the same. Returns the files the revert changed.
 */
export async function attemptRevert(
  git: Pick<GitClient, 'hasCommit' | 'parents' | 'isAncestor' | 'revert' | 'amendMessage' | 'diffNames' | 'revParse'>,
  o: { mirror: string; clone: string; base: string; culprit: string; message: string },
): Promise<RevertAttempt> {
  if (!(await git.hasCommit(o.mirror, o.culprit))) return { ok: false, reason: 'revert_unavailable' };
  if ((await git.parents(o.mirror, o.culprit)).length !== 1) return { ok: false, reason: 'revert_unavailable' };
  if (!(await git.isAncestor(o.mirror, o.culprit, o.base))) return { ok: false, reason: 'revert_unavailable' };
  if (!(await git.revert(o.clone, o.culprit))) return { ok: false, reason: 'revert_conflict' };
  const head = await git.amendMessage(o.clone, o.message);
  return { ok: true, files: await git.diffNames(o.clone, o.base, head), head };
}

/** A file of a revert that is not a plain UTF-8 text file (a link, a device, a binary). Deleted files are fine. */
export async function revertFileProblems(clone: string, files: readonly string[]): Promise<string[]> {
  const bad: string[] = [];
  for (const file of files) {
    try {
      const s = await lstat(join(clone, file));
      if (s.isSymbolicLink() || !s.isFile()) {
        bad.push(file);
        continue;
      }
      const h = await open(join(clone, file), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const buf = await h.readFile();
        if (buf.includes(0) || buf.length > MAX_PATCH_FILE_BYTES * 4) bad.push(file);
        else new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch {
        bad.push(file);
      } finally {
        await h.close();
      }
    } catch (err) {
      // A file the revert deleted is gone: that is allowed for a revert.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') bad.push(file);
    }
  }
  return bad;
}

export interface RevertJudgement {
  accepted: boolean;
  checks: ProposalCheck[];
}

/**
 * The checks of a revert: `scope` (every file is in `services/<service>/`, whatever its folder; a revert has no
 * `src/` limit and no size limit, because the culprit commit may have changed any file of the service),
 * `forbidden_file` (no link, device or binary), then `tests`. Same rule as the patch: all must pass.
 */
export async function judgeRevert(
  o: { service: ServiceName; files: readonly string[]; requireTests: boolean },
  dyn: { problems(): Promise<string[]> | string[]; tests(): Promise<TestsResult> | TestsResult },
): Promise<RevertJudgement> {
  const checks: ProposalCheck[] = [];
  const stop = (name: ProposalCheck['name']): RevertJudgement => {
    checks.push({ name, ok: false });
    return { accepted: false, checks };
  };
  if (o.files.length === 0 || !o.files.every((f) => f.startsWith(`services/${o.service}/`))) return stop('scope');
  checks.push({ name: 'scope', ok: true });
  if ((await dyn.problems()).length > 0) return stop('forbidden_file');
  checks.push({ name: 'forbidden_file', ok: true });
  const tests = await dyn.tests();
  if (!tests.ok || tests.timedOut || (tests.ran === 0 && o.requireTests)) return stop('tests');
  checks.push({ name: 'tests', ok: true });
  return { accepted: true, checks };
}
