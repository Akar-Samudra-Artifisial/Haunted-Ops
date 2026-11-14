import { FixConfigError, type FixConfig } from './fix-config.js';
import { GithubError, type GithubClient } from './github-client.js';

/** The labels of a pull request: who wrote it and what kind of patch it holds. */
export const PROPOSAL_LABELS = [
  { name: 'exorcist', color: '5b3fa0', description: 'Written by the Exorcist agent of Haunted Ops' },
  { name: 'ai_patch', color: '7a4fd0', description: 'A patch written by the fixer agent' },
  { name: 'revert', color: 'a05f3f', description: 'A revert of the culprit commit' },
] as const;

export interface StartupDeps {
  github: Pick<GithubClient, 'getRepo' | 'ensureLabels'>;
  /** `git --version`, for example `2.43.0`. */
  gitVersion: () => Promise<string>;
  log: (level: 'info' | 'warn', msg: string, fields?: Record<string, unknown>) => void;
}

/** True when `version` is at least `major.minor` (`GIT_CONFIG_COUNT` needs 2.31). */
export function gitAtLeast(version: string, major: number, minor: number): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version);
  if (m === null) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a > major || (a === major && b >= minor);
}

/**
 * Checks the setup once, when `FIX_ENABLED=true`: the git version, then `GET /repos/<repo>` (200 and the right to
 * push), then the three labels. A failure throws `FixConfigError` naming `GITHUB_TOKEN` or `LAB_GITHUB_REPO` (or
 * `FIX_ENABLED` for git), never a value. With `FIX_ENABLED=false` it does nothing and calls nothing.
 */
export async function checkFixStartup(cfg: Pick<FixConfig, 'enabled'>, deps: StartupDeps): Promise<void> {
  if (!cfg.enabled) return;
  if (!gitAtLeast(await deps.gitVersion().catch(() => ''), 2, 31)) throw new FixConfigError(['FIX_ENABLED']);
  try {
    const repo = await deps.github.getRepo();
    if (!repo.canPush) throw new FixConfigError(['GITHUB_TOKEN']);
    await deps.github.ensureLabels(PROPOSAL_LABELS);
    deps.log('info', 'github checked', { tokenDaysLeft: repo.tokenDaysLeft });
    if (repo.tokenDaysLeft !== null && repo.tokenDaysLeft < 3) deps.log('warn', 'github token expires soon', { tokenDaysLeft: repo.tokenDaysLeft });
  } catch (err) {
    if (err instanceof FixConfigError) throw err;
    if (err instanceof GithubError) throw new FixConfigError([err.code === 'github_unauthorized' || err.code === 'github_forbidden' ? 'GITHUB_TOKEN' : 'LAB_GITHUB_REPO']);
    throw new FixConfigError(['LAB_GITHUB_REPO']);
  }
}
