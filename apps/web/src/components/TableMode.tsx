import type { IngestStatus, ServiceState } from '@haunted-ops/shared';
import {
  LEVEL_MARKER,
  LEVEL_TEXT,
  formatErrorRatio,
  formatIncident,
  formatP95,
  formatReason,
  formatStaleNotice,
  formatUp,
} from '../format.js';

/** Accessible text view of the house. The full accessible mode arrives in `accessible-mode`. */
export function TableMode({
  services,
  ingest = null,
}: {
  services: readonly ServiceState[];
  ingest?: IngestStatus | null;
}) {
  return (
    <section className="table-mode" aria-labelledby="table-mode-title">
      <h2 id="table-mode-title">Services</h2>
      {ingest?.state === 'stale' ? (
        <p className="stale-notice" role="status">
          {formatStaleNotice(ingest)}
        </p>
      ) : null}
      <div className="table-scroll" tabIndex={0} role="group" aria-label="Services table, scrollable">
        <table>
          <caption className="visually-hidden">Haunt level, cause and metrics of each service</caption>
          <thead>
            <tr>
              <th scope="col">Service</th>
              <th scope="col">Haunt level</th>
              <th scope="col">Reason</th>
              <th scope="col">Error ratio</th>
              <th scope="col">p95</th>
              <th scope="col">Up</th>
              <th scope="col">Incident</th>
            </tr>
          </thead>
          <tbody>
            {services.length === 0 ? (
              <tr>
                <td colSpan={7}>No data yet</td>
              </tr>
            ) : (
              services.map((s) => (
                <tr key={s.name}>
                  <th scope="row">{s.name}</th>
                  <td>
                    <span className="marker" aria-hidden="true">
                      {LEVEL_MARKER[s.hauntLevel]}
                    </span>{' '}
                    {s.hauntLevel} ({LEVEL_TEXT[s.hauntLevel]})
                  </td>
                  <td>{formatReason(s.reason, s.metrics)}</td>
                  <td>{formatErrorRatio(s.metrics?.errorRate ?? null)}</td>
                  <td>{formatP95(s.metrics?.p95Ms ?? null)}</td>
                  <td>{formatUp(s.metrics?.up ?? null)}</td>
                  <td>{formatIncident(s.openIncident)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
