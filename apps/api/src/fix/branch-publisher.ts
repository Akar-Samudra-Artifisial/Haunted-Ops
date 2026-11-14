import { PROPOSAL_BRANCH_PATTERN, fixBranch, incidentBranch } from '@haunted-ops/shared';
import type { GitClient } from './git-client.js';
import type { GithubClient } from './github-client.js';
import { ProposalError } from './proposal-error.js';

/**
 * Creates the two branches of a Proposal on the remote: `incident/<huntId>` at the deployed commit D and
 * `exorcist/<huntId>` at the fix commit. `main` and the scenario branches are never named here: both names come
 * from the hunt id, and only those two exact forms are ever deleted.
 *
 * A retry after a partial push must not fail for ever, so a branch that is already there is handled:
 * - it points at the commit this attempt would push (D for `incident/*`, the fix commit for `exorcist/*`): done;
 * - it points elsewhere and no open pull request uses it as head or base: it is a leftover of an earlier attempt of
 *   this Hunt, so it is deleted and pushed again;
 * - an open pull request uses it: `branch_exists`, and nothing is changed.
 * Every branch is looked at before anything is deleted or pushed.
 */
export async function publishBranches(
  deps: { git: Pick<GitClient, 'push'>; github: Pick<GithubClient, 'branchHead' | 'listOpenPullRefs' | 'deleteBranch'> },
  input: { huntId: string; /** The clone that holds both commits. */ dir: string; baseSha: string; fixSha: string },
): Promise<{ baseBranch: string; branch: string }> {
  const baseBranch = incidentBranch(input.huntId);
  const branch = fixBranch(input.huntId);
  const plan = [
    { kind: 'incident' as const, name: baseBranch, sha: input.baseSha },
    { kind: 'exorcist' as const, name: branch, sha: input.fixSha },
  ];
  const heads = await Promise.all(plan.map((p) => deps.github.branchHead(p.name)));
  const stale = plan.filter((p, i) => heads[i] !== null && heads[i] !== p.sha);
  if (stale.length > 0) {
    const open = await deps.github.listOpenPullRefs();
    if (stale.some((p) => open.some((pr) => pr.head === p.name || pr.base === p.name))) throw new ProposalError('branch_exists');
    for (const p of stale) {
      // The names are built from the hunt id above; checked again so nothing else can ever be deleted here.
      if (!PROPOSAL_BRANCH_PATTERN.test(p.name)) throw new ProposalError('branch_exists');
      await deps.github.deleteBranch(p.name);
    }
  }
  for (const [i, p] of plan.entries()) {
    if (heads[i] === p.sha) continue;
    await deps.git.push(input.dir, p.kind, input.huntId, p.sha);
  }
  return { baseBranch, branch };
}
