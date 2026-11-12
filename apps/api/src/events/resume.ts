import { parseEventId, type ResyncReason } from '@haunted-ops/shared';
import type { EventBus } from './event-bus.js';
import type { BusEvent } from './ring-buffer.js';
import { formatBusEvent, formatControl } from './sse-format.js';

export type LastEventId =
  | { kind: 'none' }
  | { kind: 'id'; seq: number }
  | { kind: 'other_boot' }
  | { kind: 'malformed' };

/**
 * Reads the resume id. The `Last-Event-ID` header wins; the `lastEventId`
 * query parameter is used only when no header is present (a new browser
 * EventSource cannot set the header). Ids are `<bootId>-<seq>`; an id from a
 * different boot is `other_boot`, anything unparseable is `malformed`.
 */
export function parseLastEventId(header: unknown, query: unknown, bootId: string): LastEventId {
  const raw = header !== undefined ? header : query;
  if (raw === undefined) return { kind: 'none' };
  const parsed = parseEventId(raw);
  if (parsed === null) return { kind: 'malformed' };
  if (parsed.bootId !== bootId) return { kind: 'other_boot' };
  return { kind: 'id', seq: parsed.seq };
}

export interface ResumeSubscription {
  /** Removes the bus subscription. Safe to call more than once. */
  readonly unsubscribe: () => void;
}

/**
 * Subscribes a writer to the bus and replays from lastEventId.
 * Writes `connected` (with the boot id) first. Then: subscribe and queue live
 * events, write the replay or a `resync`, then flush the queue skipping ids
 * already written. Every id is written at most once and in increasing order,
 * and no id after the resume point is skipped.
 */
export function subscribeWithResume(bus: EventBus, last: LastEventId, write: (chunk: string) => void): ResumeSubscription {
  const boot = bus.bootId;
  let lastSent = bus.buffer.latestId();
  let replaying = true;
  const queue: BusEvent[] = [];

  write(formatControl('connected', { bootId: boot }));

  const unsubscribe = bus.subscribe((event) => {
    if (replaying) {
      queue.push(event);
      return;
    }
    if (event.id > lastSent) {
      lastSent = event.id;
      write(formatBusEvent(boot, event));
    }
  });

  const resync = (reason: ResyncReason): void => write(formatControl('resync', { reason }));

  if (last.kind === 'malformed') {
    resync('malformed');
  } else if (last.kind === 'other_boot') {
    resync('restarted');
  } else if (last.kind === 'id') {
    const replay = bus.buffer.since(last.seq);
    if (replay === 'too_old' || replay === 'ahead') {
      resync(replay);
    } else {
      lastSent = last.seq;
      for (const event of replay) {
        write(formatBusEvent(boot, event));
        lastSent = event.id;
      }
    }
  }

  for (const event of queue) {
    if (event.id > lastSent) {
      write(formatBusEvent(boot, event));
      lastSent = event.id;
    }
  }
  queue.length = 0;
  replaying = false;

  return { unsubscribe };
}
