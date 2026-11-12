import type { ConnectionStatus } from '../net/status.js';

const LABELS: Record<ConnectionStatus, string> = {
  live: 'live',
  reconnecting: 'reconnecting',
  offline: 'offline',
};

/** Shape plus text, so the status never relies on color alone. */
function StatusIcon({ status }: { status: ConnectionStatus }) {
  const common = { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true, focusable: false } as const;
  if (status === 'live') {
    return (
      <svg {...common} className="status-icon">
        <circle cx="6" cy="6" r="5" fill="currentColor" />
      </svg>
    );
  }
  if (status === 'reconnecting') {
    return (
      <svg {...common} className="status-icon">
        <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M6 1.5 A4.5 4.5 0 0 1 6 10.5 Z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg {...common} className="status-icon">
      <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function Header({ status }: { status: ConnectionStatus }) {
  return (
    <header className="app-header">
      <h1 className="app-title">Haunted Ops</h1>
      <p className={`connection connection-${status}`} role="status" aria-live="polite" aria-atomic="true">
        <StatusIcon status={status} />
        <span>Connection: {LABELS[status]}</span>
      </p>
    </header>
  );
}
