import type { GithubClient } from './github-client.js';
import { assertPrText, prBody, prTitle, type PrFacts } from './pr-text.js';

/**
 * Opens the pull request `head` into `base` with the sanitized text, then adds the labels `exorcist` and the kind.
 * No reviewer is requested and auto-merge is not enabled (the client has no such call). The text is checked against
 * the rules before it is sent; a label that cannot be added does not undo the pull request.
 */
export async function openPullRequest(
  github: Pick<GithubClient, 'createPull' | 'addLabels'>,
  facts: PrFacts,
  branches: { head: string; base: string },
): Promise<{ number: number; htmlUrl: string; labeled: boolean }> {
  const title = prTitle(facts);
  const body = prBody(facts);
  assertPrText(title, body, { repo: facts.repo, webOrigin: facts.webOrigin });
  const pr = await github.createPull({ title, head: branches.head, base: branches.base, body });
  let labeled = true;
  try {
    await github.addLabels(pr.number, ['exorcist', facts.kind]);
  } catch {
    labeled = false;
  }
  return { ...pr, labeled };
}
