import { useEffect, useRef } from 'react';
import type { IngestStatus, ServiceName, ServiceState } from '@haunted-ops/shared';
import { useFocusAnchor } from '../a11y/focus.js';
import { hauntMark } from '../a11y/status-marks.js';
import { formatStaleNotice } from '../format.js';
import { HuntSection, huntSectionService, type LoadHuntDetail } from './HuntSection.js';
import { tableRowText } from './table-model.js';

/** Accessible text view of the house, and the main view in Accessible mode. */
export function TableMode({
  services,
  ingest = null,
  selected = null,
  onSelect,
  loadHuntDetail,
}: {
  services: readonly ServiceState[];
  ingest?: IngestStatus | null;
  selected?: ServiceName | null;
  onSelect?: (name: ServiceName | null) => void;
  /** Loads the detail of a finished Hunt; without it the section shows the summary only. */
  loadHuntDetail?: LoadHuntDetail;
}) {
  const selectedRow = useRef<HTMLTableRowElement | null>(null);
  const region = useRef<HTMLElement | null>(null);
  useFocusAnchor(region);
  useEffect(() => {
    // The scene can select a room; bring its row into view.
    selectedRow.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  return (
    <section id="services" ref={region} tabIndex={-1} className="table-mode" aria-labelledby="table-mode-title">
      <h2 id="table-mode-title">Services</h2>
      {ingest?.state === 'stale' ? (
        <p className="stale-notice">
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
              <th scope="col">Hunt</th>
              <th scope="col">Fix</th>
            </tr>
          </thead>
          <tbody>
            {services.length === 0 ? (
              <tr>
                <td colSpan={9}>No data yet</td>
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
                    data-row={s.name}
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
                        {hauntMark(s.hauntLevel).symbol}
                      </span>{' '}
                      {row.level}
                    </td>
                    <td>{row.reason}</td>
                    <td>{row.errorRatio}</td>
                    <td>{row.p95}</td>
                    <td>{row.up}</td>
                    <td>{row.incident}</td>
                    <td>{row.hunt}</td>
                    <td data-testid="fix-cell">{row.fix}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <HuntSection service={huntSectionService(services, selected)} loadDetail={loadHuntDetail} />
    </section>
  );
}
