import { LEVEL_MARKER, LEVEL_TEXT } from '../format.js';
import { PROPOSAL_STATUS_TEXT } from '../components/proposal-text.js';
export interface StatusMark {
  /** The words of the status; a screen reader hears these. */
  label: string;
  /** A plain character that differs from the other statuses of its group; hidden from screen readers. */
  symbol: string;
}
/**
 * Every status has a text label and a symbol, so none depends on colour alone. Within a group no two
 * statuses share a symbol.
 */
export const MARKS = {
  haunt: {
    calm: { label: LEVEL_TEXT[0], symbol: LEVEL_MARKER[0] },
    uneasy: { label: LEVEL_TEXT[1], symbol: LEVEL_MARKER[1] },
    haunted: { label: LEVEL_TEXT[2], symbol: LEVEL_MARKER[2] },
    possessed: { label: LEVEL_TEXT[3], symbol: LEVEL_MARKER[3] },
    dark: { label: LEVEL_TEXT[4], symbol: LEVEL_MARKER[4] },
    'room-dark': { label: 'room dark', symbol: '■' },
  },
  connection: {
    live: { label: 'live', symbol: '●' },
    reconnecting: { label: 'reconnecting', symbol: '◐' },
    offline: { label: 'offline', symbol: '✕' },
    demo: { label: 'demo data', symbol: '◇' },
  },
  deploy: {
    deploying: { label: 'deploying', symbol: '▷' },
    deployed: { label: 'deployed', symbol: '✓' },
    failed: { label: 'deploy failed', symbol: '✕' },
  },
  proposal: {
    drafting: { label: PROPOSAL_STATUS_TEXT.drafting, symbol: '…' },
    checks_failed: { label: PROPOSAL_STATUS_TEXT.checks_failed, symbol: '!' },
    open: { label: PROPOSAL_STATUS_TEXT.open, symbol: '◌' },
    merged: { label: PROPOSAL_STATUS_TEXT.merged, symbol: '◆' },
    deployed: { label: PROPOSAL_STATUS_TEXT.deployed, symbol: '✓' },
    rejected: { label: PROPOSAL_STATUS_TEXT.rejected, symbol: '⊘' },
    failed: { label: PROPOSAL_STATUS_TEXT.failed, symbol: '✕' },
  },
} as const satisfies Record<string, Record<string, StatusMark>>;
const HAUNT_KEYS = ['calm', 'uneasy', 'haunted', 'possessed', 'dark'] as const;
/** The mark of a Haunt level, 0 to 4. */
export function hauntMark(level: 0 | 1 | 2 | 3 | 4): StatusMark {
  return statusMark('haunt', HAUNT_KEYS[level]);
}
export type MarkGroup = keyof typeof MARKS;
export function statusMark<G extends MarkGroup>(group: G, status: keyof (typeof MARKS)[G]): StatusMark {
  return (MARKS[group] as Record<keyof (typeof MARKS)[G], StatusMark>)[status];
}
