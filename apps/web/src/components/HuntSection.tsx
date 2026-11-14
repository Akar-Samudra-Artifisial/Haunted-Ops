import { useEffect, useState } from 'react';
import { isActiveProposalStatus, type HuntDetail, type HuntSummary, type ServiceName, type ServiceState } from '@haunted-ops/shared';
import { huntCellText, huntStepText, huntView } from './hunt-text.js';
import { proposalView } from './proposal-text.js';

export type LoadHuntDetail = (huntId: string) => Promise<HuntDetail>;

/** The Service the Hunt section is about: the selected one, else the first with a running or queued Hunt, else one with an active fix. */
export function huntSectionService(services: readonly ServiceState[], selected: ServiceName | null): ServiceState | null {
  if (selected !== null) return services.find((s) => s.name === selected) ?? null;
  return (
    services.find((s) => s.hunt?.status === 'running') ??
    services.find((s) => s.hunt?.status === 'queued') ??
    // Then a fix that is still moving, so its pull request link is in the table without a selection.
    services.find((s) => s.proposal !== null && isActiveProposalStatus(s.proposal.status)) ??
    null
  );
}

/** Loads the detail of a finished Hunt that has a diagnosis, so the cited evidence can be listed. */
function useHuntDetail(hunt: HuntSummary | null, load: LoadHuntDetail | undefined): HuntDetail | null {
  const [detail, setDetail] = useState<HuntDetail | null>(null);
  const id = hunt?.status === 'succeeded' ? hunt.id : null;
  useEffect(() => {
    // A detail that belongs to another Hunt is never returned (checked below), so nothing to reset.
    if (id === null || load === undefined) return;
    let live = true;
    load(id).then(
      (d) => {
        if (live) setDetail(d);
      },
      () => {
        if (live) setDetail(null);
      },
    );
    return () => {
      live = false;
    };
  }, [id, load]);
  return detail !== null && detail.id === id ? detail : null;
}

/** Text view of the latest Hunt of one Service: steps as an ordered list, and a valid diagnosis with its cited evidence. */
export function HuntSection({ service, loadDetail }: { service: ServiceState | null; loadDetail?: LoadHuntDetail }) {
  const hunt = service?.hunt ?? null;
  const detail = useHuntDetail(hunt, loadDetail);
  if (service === null) return null;
  const view = huntView(hunt);
  const steps = detail?.allSteps ?? hunt?.steps ?? [];
  const hidden = hunt === null ? 0 : hunt.stepCount - steps.length;
  const cited = detail?.evidence.filter((e) => e.cited) ?? [];
  return (
    <section className="hunt-section" aria-labelledby="hunt-section-title" data-testid="hunt-section">
      <h3 id="hunt-section-title">Hunt on {service.name}</h3>
      <p data-testid="hunt-state">{huntCellText(view)}</p>
      {steps.length > 0 ? (
        <>
          {hidden > 0 ? <p>Showing the last {steps.length} of {hunt?.stepCount} steps.</p> : null}
          <ol aria-label={`Steps of the hunt on ${service.name}`}>
            {steps.map((step) => (
              <li key={step.index} value={step.index}>
                {huntStepText(step)}
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p>No steps yet.</p>
      )}
      {hunt?.diagnosis ? (
        <div data-testid="hunt-diagnosis">
          <p>
            Culprit: deploy {hunt.diagnosis.culpritDeploy}, commit {view.culprit?.shortSha}
            {view.causedBy === null ? '' : `, caused by ${view.causedBy}`}.
          </p>
          <p>
            {hunt.diagnosis.summary} <AiLabel />
          </p>
          {detail?.fixHint ? (
            <p>
              Fix hint: {detail.fixHint} <AiLabel />
            </p>
          ) : null}
          {cited.length > 0 ? (
            <>
              <p id="hunt-evidence-title">Cited evidence</p>
              <ul aria-labelledby="hunt-evidence-title">
                {cited.map((e) => (
                  <li key={e.index}>
                    {e.kind}: {e.detail}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
      <ProposalBlock service={service} />
    </section>
  );
}

/** Text view of the latest Proposal of one Service: kind, status, checks in words, the pull request link. */
function ProposalBlock({ service }: { service: ServiceState }) {
  const p = service.proposal;
  if (p === null) return null;
  const v = proposalView(p, service.name);
  return (
    <div data-testid="proposal-block">
      <h4>Fix proposal, attempt {p.attempt}</h4>
      <p data-testid="proposal-state">{v.cell}</p>
      {v.checksText === null ? null : <p>Checks: {v.checksText}.</p>}
      {v.aiFailText === null ? null : <p>AI patch not used: {v.aiFailText}.</p>}
      {v.link === null ? null : (
        <p>
          <a href={v.link.href} target="_blank" rel="noopener noreferrer">
            {v.link.label} on GitHub (opens in a new tab)
          </a>
        </p>
      )}
    </div>
  );
}

/** The summary and the fix hint are written by the model: they are shown as plain text with this label. */
export function AiLabel() {
  return <small className="ai-label">AI generated</small>;
}
