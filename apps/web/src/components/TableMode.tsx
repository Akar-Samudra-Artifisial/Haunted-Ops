import { useEffect, useRef } from 'react';
import type { IngestStatus, ServiceName, ServiceState } from '@haunted-ops/shared';
import { useFocusAnchor } from '../a11y/focus.js';
import { hauntMark } from '../a11y/status-marks.js';
import { formatStaleNotice } from '../format.js';
import { HuntSection, huntSectionService, type LoadHuntDetail } from './HuntSection.js';
import { tableRowText } from './table-model.js';

const COLUMNS = ['Service', 'Haunt level', 'Reason', 'Error ratio', 'p95', 'Up', 'Incident', 'Hunt', 'Fix'] as const;
/** Accessible text view of the house, and the main view in Accessible mode. */
export function TableMode({
  services,
  ingest = null,
  selected = null,
  onSelect,
  loadHuntDetail,
  captionNote,
  showHunt = true,
}: {
  services: readonly ServiceState[];
  ingest?: IngestStatus | null;
  selected?: ServiceName | null;
  onSelect?: (name: ServiceName | null) => void;
  /** Loads the detail of a finished Hunt; without it the section shows the summary only. */
  loadHuntDetail?: LoadHuntDetail;
  /** Said first in the caption: "Replay of <date>, not live". */
  captionNote?: string;
  /** The page shows the Hunt in the Panel and turns this off; on its own the table holds the Hunt section. */
  showHunt?: boolean;
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
        <table role="table">
          <caption className="visually-hidden">{captionNote === undefined ? '' : `${captionNote}. `}Haunt level, cause and metrics of each service</caption>
          <thead>
            <tr role="row">
              {COLUMNS.map((c) => (
                <th key={c} scope="col" role="columnheader">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {services.length === 0 ? (
              <tr role="row">
                <td colSpan={9} role="cell">
                  No data yet
                </td>
              </tr>
            ) : (
              services.map((s) => {
                const row = tableRowText(s);
                const isSelected = selected === s.name;
                return (
                  <tr
                    role="row"
                    key={s.name}
                    ref={isSelected ? selectedRow : undefined}
                    aria-current={isSelected ? 'true' : undefined}
                    data-row={s.name}
                    data-selected={isSelected ? 'true' : undefined}
                    data-room-state={row.dark ? 'dark' : 'lit'}
                  >
                    <th scope="row" role="rowheader" data-label="Service">
                      {isSelected ? (
                        <span className="row-marker" aria-hidden="true">
                          ▶{' '}
                        </span>
                      ) : null}
                      <button type="button" className="row-select" aria-pressed={isSelected} onClick={() => onSelect?.(isSelected ? null : s.name)}>
                        {s.name}
                      </button>
                    </th>
                    <td role="cell" data-label="Haunt level">
                      <span className="pill pill--level" data-level={s.hauntLevel}>
                        <span className="marker" aria-hidden="true">
                          {hauntMark(s.hauntLevel).symbol}
                        </span>{' '}
                        {row.level}
                      </span>
                    </td>
                    <td role="cell" data-label="Reason">
                      {row.reason}
                    </td>
                    <td role="cell" data-label="Error ratio" className="num">
                      {row.errorRatio}
                    </td>
                    <td role="cell" data-label="p95" className="num">
                      {row.p95}
                    </td>
                    <td role="cell" data-label="Up">
                      {row.up}
                    </td>
                    <td role="cell" data-label="Incident">
                      {row.incident}
                    </td>
                    <td role="cell" data-label="Hunt">
                      {row.hunt}
                    </td>
                    <td role="cell" data-label="Fix" data-testid="fix-cell">
                      {row.fix}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {showHunt ? <HuntSection service={huntSectionService(services, selected)} loadDetail={loadHuntDetail} /> : null}
    </section>
  );
}
