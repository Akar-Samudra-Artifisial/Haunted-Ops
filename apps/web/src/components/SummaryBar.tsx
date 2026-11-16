import type { ServiceState } from '@haunted-ops/shared';
import { summarize } from './summary.js';
/** One line of plain text: how many services are at each level, then what the Hunt is doing. Not a live region. */
export function SummaryBar({ services }: { services: readonly ServiceState[] }) {
  const { counts, huntState, running } = summarize(services);
  return (
    <section className="summary" aria-label="Summary" data-testid="summary-bar">
      <p className="summary-counts">
        {counts.length === 0
          ? 'No services yet'
          : counts.map((c, i) => (
              <span key={c.level} className="summary-count" data-level={c.level}>
                {i > 0 ? ' · ' : ''}
                <span className="marker" aria-hidden="true">
                  {c.symbol}
                </span>{' '}
                <span className="num">{c.count}</span> {c.word}
              </span>
            ))}
      </p>
      {huntState === null ? null : (
        <p className="summary-hunt" data-testid="summary-hunt">
          <span className={running ? 'pill pill--running' : 'pill pill--ecto'}>{huntState}</span>
        </p>
      )}
    </section>
  );
}
