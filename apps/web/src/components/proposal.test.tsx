import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProposalSummary } from '@haunted-ops/shared';
import { makeService } from '../test/arbs.js';
import { sealedHunt } from '../test/hunt-arbs.js';
import { HuntSection } from './HuntSection.js';
import { proposalView } from './proposal-text.js';
import { TableMode } from './TableMode.js';

afterEach(() => {
  cleanup();
});

const proposal = (over: Partial<ProposalSummary>): ProposalSummary => ({
  id: 'cmproposalaaaaaaaaaaaaaa1',
  huntId: 'cmhuntaaaaaaaaaaaaaaaaaa1',
  attempt: 1,
  kind: 'revert',
  status: 'open',
  prNumber: 7,
  prUrl: 'https://github.com/example/haunted-lab/pull/7',
  mergedBy: null,
  checks: [
    { name: 'scope', ok: true },
    { name: 'tests', ok: true },
  ],
  failReason: null,
  aiFailReason: 'tests_failed',
  updatedAt: '2026-11-14T10:00:00.000Z',
  ...over,
});

describe('the Fix column and the Fix block', () => {
  it('says the kind, the status, the Checks in words and links to GitHub in a new tab', () => {
    const service = makeService('payments', { hunt: sealedHunt(), proposal: proposal({}) });
    render(<TableMode services={[service]} />);
    expect(within(screen.getByRole('row', { name: /^payments\b/ })).getByText('Fix (revert), pull request open, waiting for review')).toBeTruthy();
    const block = within(screen.getByTestId('proposal-block'));
    expect(block.getByText('Checks: in scope passed, tests passed.')).toBeTruthy();
    expect(block.getByText('AI patch not used: tests failed.')).toBeTruthy();
    const link = block.getByRole('link', { name: /Pull request #7 on GitHub/ });
    expect(link.getAttribute('href')).toBe('https://github.com/example/haunted-lab/pull/7');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('shows no link for a URL that is not GitHub, and "merged by" after a merge', () => {
    const odd = makeService('payments', { proposal: proposal({ prUrl: 'https://example.com/pull/7' }) });
    render(<HuntSection service={odd} />);
    expect(screen.queryByRole('link')).toBeNull();
    cleanup();
    const merged = makeService('payments', { proposal: proposal({ status: 'merged', mergedBy: 'octocat' }) });
    render(<HuntSection service={merged} />);
    expect(screen.getByTestId('proposal-state').textContent).toBe('Fix (revert), merged, deploying, merged by @octocat');
  });

  it('says merged without a login when GitHub names no one', () => {
    const p = proposal({ status: 'deployed', mergedBy: null });
    render(<HuntSection service={makeService('payments', { proposal: p })} />);
    expect(screen.getByTestId('proposal-state').textContent).toBe('Fix (revert), fix deployed');
    expect(proposalView({ ...p, status: 'merged' }, 'payments')).toMatchObject({ cell: 'Fix (revert), merged, deploying', sentence: 'Fix merged on payments.', mergedBy: null });
  });

  it('shows nothing for a Service without a Proposal', () => {
    render(<HuntSection service={makeService('payments', {})} />);
    expect(screen.queryByTestId('proposal-block')).toBeNull();
  });
});
