import {
  formatEventId,
  formatSseFrame,
  type ControlEventName,
  type ControlEventPayloads,
} from '@haunted-ops/shared';
import type { BusEvent } from './ring-buffer.js';

/** Domain event frame: always has an id `<bootId>-<seq>`. */
export function formatBusEvent(bootId: string, event: BusEvent): string {
  return formatSseFrame({ id: formatEventId(bootId, event.id), event: event.name, data: event.payload });
}

/** Control frame (connected, heartbeat, resync): never has an id, so it does not move Last-Event-ID. */
export function formatControl<K extends ControlEventName>(name: K, payload: ControlEventPayloads[K]): string {
  return formatSseFrame({ event: name, data: payload });
}

/** Tells the browser how long to wait before its own automatic reconnect. */
export function formatRetry(ms: number): string {
  return `retry: ${Math.max(0, Math.floor(ms))}\n\n`;
}
