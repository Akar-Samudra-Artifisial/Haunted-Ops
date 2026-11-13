import { useEffect, useRef } from 'react';
import type { IngestStatus, ServiceName, ServiceState } from '@haunted-ops/shared';
import { LEVEL_MARKER, formatStaleNotice } from '../format.js';
import { tableRowText } from './table-model.js';

/** Accessible text view of the house. The full accessible mode arrives in `accessible-mode`. */
export function TableMode({
  services,
  ingest = null,
  selected = null,
  onSelect,
}: {
  services: readonly ServiceState[];
  ingest?: IngestStatus | null;
  selected?: ServiceName | null;
  onSelect?: (name: ServiceName | null) => void;
}) {
  const selectedRow = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    // The scene can select a room; bring its row into view.
    selectedRow.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

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
              services.map((s) => {
                const row = tableRowText(s);
                const isSelected = selected === s.name;
                return (
                  <tr
                    key={s.name}
                    ref={isSelected ? selectedRow : undefined}
                    aria-current={isSelected ? 'true' : undefined}
                    data-selected={isSelected ? 'true' : undefined}
                    data-room-state={row.dark ? 'dark' : 'lit'}
                  >
                    <th scope="row">
                      {isSelected ? (
                        <span className="row-marker" aria-hidden="true">
                          ▶{' '}
                        </span>
                      ) : null}
                      <button type="button" className="row-select" aria-pressed={isSelected} onClick={() => onSelect?.(isSelected ? null : s.name)}>
                        {s.name}
                      </button>
                    </th>
                    <td>
                      <span className="marker" aria-hidden="true">
                        {LEVEL_MARKER[s.hauntLevel]}
                      </span>{' '}
                      {row.level}
                    </td>
                    <td>{row.reason}</td>
                    <td>{row.errorRatio}</td>
                    <td>{row.p95}</td>
                    <td>{row.up}</td>
                    <td>{row.incident}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
