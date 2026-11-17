import { statusMark } from '../a11y/status-marks.js';
import type { ConnectionStatus } from '../net/status.js';
import { AccessibleSwitch } from './AccessibleSwitch.js';
import { SoundButton, type SoundSwitch } from './SoundButton.js';
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
export function Header({ status, demo = false, note, accessible, sound }: { status: ConnectionStatus; demo?: boolean; note?: string; accessible?: AccessibleControl; sound?: SoundSwitch }) {
  const control = (
    <>
      {accessible === undefined ? null : <AccessibleSwitch on={accessible.on} onToggle={accessible.onToggle} />}
      {sound === undefined ? null : <SoundButton {...sound} />}
    </>
  );
  const brand = (
    <div className="app-brand">
      <h1 className="app-title">Haunted Ops</h1>
      <p className="app-tagline">Live incident war room. Ghosts are errors, fog is latency, a dark room is down.</p>
    </div>
  );
  if (demo || note !== undefined) {
    return (
      <header className="app-header">
        {brand}
        <div className="app-controls">
          {control}
          <p className="connection connection-demo">{note ?? 'Demo data, not live'}</p>
        </div>
      </header>
    );
  }
  return (
    <header className="app-header">
      {brand}
      <div className="app-controls">
        {control}
        <p className={`connection connection-${status}`}>
          <StatusIcon status={status} />
          <span>Connection: {statusMark('connection', status).label}</span>
        </p>
      </div>
    </header>
  );
}
