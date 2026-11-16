import { statusMark } from '../a11y/status-marks.js';
import type { ConnectionStatus } from '../net/status.js';
import { AccessibleSwitch } from './AccessibleSwitch.js';

export interface AccessibleControl {
  on: boolean;
  onToggle: () => void;
}

/** The symbol of the status, hidden from screen readers; the text beside it says the same. */
function StatusIcon({ status }: { status: ConnectionStatus | 'demo' }) {
  return (
    <span className="status-icon" aria-hidden="true">
      {statusMark('connection', status).symbol}
    </span>
  );
}

export function Header({ status, demo = false, note, accessible }: { status: ConnectionStatus; demo?: boolean; note?: string; accessible?: AccessibleControl }) {
  const control = accessible === undefined ? null : <AccessibleSwitch on={accessible.on} onToggle={accessible.onToggle} />;
  if (demo || note !== undefined) {
    return (
      <header className="app-header">
        <h1 className="app-title">Haunted Ops</h1>
        {control}
        <p className="connection connection-demo">
          {note ?? 'Demo data, not live'}
        </p>
      </header>
    );
  }
  return (
    <header className="app-header">
      <h1 className="app-title">Haunted Ops</h1>
      {control}
      <p className={`connection connection-${status}`}>
        <StatusIcon status={status} />
        <span>Connection: {statusMark('connection', status).label}</span>
      </p>
    </header>
  );
}
