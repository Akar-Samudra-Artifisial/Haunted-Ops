export type ConnectionStatus = 'live' | 'reconnecting' | 'offline';

/** Silence longer than this means the stream is not live (heartbeats come every 15 s). */
export const LIVE_WINDOW_MS = 45_000;
/** Consecutive failed attempts before the status becomes offline. */
export const OFFLINE_AFTER_FAILURES = 5;

export interface ConnectionState {
  open: boolean;
  online: boolean;
  failures: number;
  lastActivityAt: number | null;
  now: number;
  status: ConnectionStatus;
}

export type ConnectionAction =
  | { type: 'open'; at: number }
  | { type: 'message'; at: number }
  | { type: 'error'; at: number }
  | { type: 'tick'; at: number }
  | { type: 'online'; at: number }
  | { type: 'offline'; at: number };

export function deriveStatus(s: Omit<ConnectionState, 'status'>): ConnectionStatus {
  if (!s.online || s.failures >= OFFLINE_AFTER_FAILURES) return 'offline';
  if (s.open && s.lastActivityAt !== null && s.now - s.lastActivityAt <= LIVE_WINDOW_MS) return 'live';
  return 'reconnecting';
}

export function initialConnectionState(now: number, online = true): ConnectionState {
  const base = { open: false, online, failures: 0, lastActivityAt: null, now };
  return { ...base, status: deriveStatus(base) };
}

/** Pure reducer for the connection status shown in the header. */
export function reduceConnection(state: ConnectionState, action: ConnectionAction): ConnectionState {
  const now = Math.max(state.now, action.at);
  let next: Omit<ConnectionState, 'status'>;
  switch (action.type) {
    case 'open':
      next = { ...state, open: true, failures: 0, lastActivityAt: now, now };
      break;
    case 'message':
      next = { ...state, lastActivityAt: now, now };
      break;
    case 'error':
      next = { ...state, open: false, failures: state.failures + 1, now };
      break;
    case 'tick':
      next = { ...state, now };
      break;
    case 'online':
      next = { ...state, online: true, now };
      break;
    case 'offline':
      next = { ...state, online: false, open: false, now };
      break;
  }
  return { ...next, status: deriveStatus(next) };
}
