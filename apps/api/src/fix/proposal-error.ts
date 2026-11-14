import { PROPOSAL_FAIL_REASONS, type ProposalFailReason } from '@haunted-ops/shared';
import { GitError } from './git-client.js';
import { GithubError } from './github-client.js';

/** A step of the fix flow failed with a fixed reason. Nothing else about the failure is kept. */
export class ProposalError extends Error {
  constructor(readonly reason: ProposalFailReason) {
    super(reason);
    this.name = 'ProposalError';
  }
}

/** The fixed reason of any error: git and GitHub codes map to theirs, anything else is `internal`. */
export function failReasonOf(err: unknown): ProposalFailReason {
  if (err instanceof ProposalError) return err.reason;
  if (err instanceof GithubError) return err.code;
  if (err instanceof GitError) {
    if (err.code === 'push_rejected') return 'push_rejected';
    if (err.code === 'fetch_failed' || err.code === 'git_timeout') return 'github_unavailable';
    return 'internal';
  }
  return 'internal';
}

/** A short code for a log line: the fixed reason, never a message. */
export const errorCodeOf = (err: unknown): string => {
  const reason = failReasonOf(err);
  return (PROPOSAL_FAIL_REASONS as readonly string[]).includes(reason) ? reason : 'internal';
};
