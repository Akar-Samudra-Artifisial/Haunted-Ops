// Feature: accessible-mode, Property 4: every Scene fact appears as text
import { cleanup, render, screen } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { AI_FAIL_REASONS, PROPOSAL_CHECK_NAMES, PROPOSAL_FAIL_REASONS, PROPOSAL_KINDS, PROPOSAL_STATUSES, SERVICE_NAMES, shortSha, type ProposalSummary, type ServiceState } from '@haunted-ops/shared';
import { makeService, serviceStateArb } from '../test/arbs.js';
import { huntSummaryArb } from '../test/hunt-arbs.js';
import { FULL } from '../test/scene-fakes.js';
import { toSceneModel } from '../scene/model.js';
import { hauntMark } from '../a11y/status-marks.js';
import { huntCellText, huntStepText, huntView } from './hunt-text.js';
import { checksInWords, proposalView } from './proposal-text.js';
import { TableMode } from './TableMode.js';
import { tableRowText } from './table-model.js';

afterEach(cleanup);

const proposalArb: fc.Arbitrary<ProposalSummary> = fc.record({
  id: fc.constant('cmproposalaaaaaaaaaaaaaa1'),
  huntId: fc.constant('cmhuntaaaaaaaaaaaaaaaaaa1'),
  attempt: fc.integer({ min: 1, max: 3 }),
  kind: fc.option(fc.constantFrom(...PROPOSAL_KINDS), { nil: null }),
  status: fc.constantFrom(...PROPOSAL_STATUSES),
  prNumber: fc.option(fc.integer({ min: 1, max: 99999 }), { nil: null }),
  // Most links are GitHub; some are not and must never become a link.
  prUrl: fc.option(
    fc.tuple(fc.constantFrom('https://github.com/example/haunted-lab/pull', 'https://github.com/example/haunted-lab/pull', 'http://github.com/x/pull', 'https://evil.example/pull', 'javascript:alert'), fc.integer({ min: 1, max: 99999 })).map(([base, n]) => `${base}/${n}`),
    { nil: null },
  ),
  mergedBy: fc.option(fc.constantFrom('octocat', 'on-call-human'), { nil: null }),
  checks: fc.array(fc.record({ name: fc.constantFrom(...PROPOSAL_CHECK_NAMES), ok: fc.boolean() }), { maxLength: 4 }),
  failReason: fc.option(fc.constantFrom(...PROPOSAL_FAIL_REASONS), { nil: null }),
  aiFailReason: fc.option(fc.constantFrom(...AI_FAIL_REASONS), { nil: null }),
  updatedAt: fc.constant('2026-11-14T10:00:00.000Z'),
});

const NOW = Date.parse('2026-11-13T10:00:30.000Z');

describe('Property 4: every Scene fact appears as text in Accessible mode', () => {
  it('has the room status, metrics, hunt, diagnosis, proposal, checks and link in the table and its detail', () => {
    fc.assert(
      fc.property(
        serviceStateArb,
        fc.option(huntSummaryArb, { nil: null }),
        fc.option(proposalArb, { nil: null }),
        fc.constantFrom(...SERVICE_NAMES),
        (base, hunt, proposal, name) => {
          cleanup();
          const s: ServiceState = makeService(name, { ...base, name, room: makeService(name).room, hunt: hunt === null ? null : { ...hunt, service: name }, proposal });
          render(<TableMode services={[s]} selected={name} />);
          const text = document.body.textContent ?? '';
          const room = toSceneModel([s], NOW, FULL).rooms[0]!;
          const row = tableRowText(s);
          // What the Scene shows of the room.
          expect(text).toContain(`${room.level} (${room.levelLabel})`);
          // The status label and its symbol, side by side in the Haunt level cell.
          expect(text).toContain(`${hauntMark(s.hauntLevel).symbol} ${row.level}`);
          expect(text).toContain(row.errorRatio);
          expect(text).toContain(row.p95);
          expect(text).toContain(row.up);
          expect(text).toContain(room.badge === '' ? 'none' : room.badge);
          expect(text).toContain(row.incident);
          if (room.dark) expect(text).toMatch(/dark/);
          // The Hunt: the label, each step, the diagnosis.
          if (room.hunt !== null) expect(text).toContain(room.hunt.label);
          if (s.hunt !== null) {
            for (const step of s.hunt.steps) expect(text).toContain(huntStepText(step));
            const view = huntView(s.hunt);
            expect(text).toContain(huntCellText(view));
            if (view.culprit !== null && s.hunt.diagnosis !== null) {
              // The culprit deploy is the deploy the Scene points at; the Service state has no other deploy.
              expect(text).toContain(`deploy ${s.hunt.diagnosis.culpritDeploy}, commit ${view.culprit.shortSha}`);
              expect(view.culprit.shortSha).toBe(shortSha(s.hunt.diagnosis.culpritSha));
              expect(text).toContain(s.hunt.diagnosis.summary);
            }
          }
          // The fix proposal: the label, the checks, the reason, the link.
          const v = proposalView(s.proposal);
          expect(text).toContain(v.cell);
          if (s.proposal !== null) {
            expect(text).toContain(v.statusText);
            if (v.kindText !== null) expect(text).toContain(`Fix (${v.kindText})`);
            // Each check by name and result, in the words of the table.
            for (const c of s.proposal.checks) expect(text).toContain(checksInWords([c]) as string);
          }
          if (v.checksText !== null) expect(text).toContain(`Checks: ${v.checksText}.`);
          if (v.aiFailText !== null) expect(text).toContain(`AI patch not used: ${v.aiFailText}.`);
          if (v.link !== null) {
            const link = screen.getByRole('link', { name: new RegExp(v.link.label) });
            expect(link.getAttribute('href')).toBe(v.link.href);
          }
          // Only https://github.com/ links reach the page.
          for (const a of document.querySelectorAll('a[href]')) expect(a.getAttribute('href')?.startsWith('https://github.com/')).toBe(true);
          if (v.link === null) expect(screen.queryByRole('link', { name: /Pull request/ })).toBeNull();
        },
      ),
      { numRuns: 120 },
    );
  });
});
