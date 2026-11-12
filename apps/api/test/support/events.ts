import { parseEventId, parseSseFrame, type SseFrame } from '@haunted-ops/shared';
import type { EventBus } from '../../src/events/event-bus.js';

export const TEST_BOOT = 'a1b2c3d4e5f6';
export const OTHER_BOOT = 'ffffffffffff';

/** Publishes n valid events and returns their sequence numbers. */
export function publishN(bus: EventBus, n: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      bus.publish('signal.recorded', { service: 'payments', kind: 'error_rate', value: i, at: '2026-11-12T10:00:00.000Z' }).id,
    );
  }
  return ids;
}

/** Splits written SSE chunks into parsed frames (comments and retry lines skipped). */
export function framesOf(chunks: readonly string[]): SseFrame[] {
  return chunks
    .join('')
    .split('\n\n')
    .filter((block) => block.trim() !== '' && !block.startsWith('retry:') && !block.startsWith(':'))
    .map((block) => {
      const frame = parseSseFrame(`${block}\n\n`);
      if (frame === null) throw new Error(`unparseable frame: ${block}`);
      return frame;
    });
}

/** Frames other than the leading `connected` event. */
export function afterConnected(frames: readonly SseFrame[]): SseFrame[] {
  return frames[0]?.event === 'connected' ? frames.slice(1) : [...frames];
}

/** Sequence numbers of domain frames; throws if an id is not `<bootId>-<seq>` of the given boot. */
export function seqsOf(frames: readonly SseFrame[], bootId: string): number[] {
  return frames
    .filter((f) => f.id !== undefined)
    .map((f) => {
      const parsed = parseEventId(f.id);
      if (parsed === null || parsed.bootId !== bootId) throw new Error(`unexpected id ${String(f.id)}`);
      return parsed.seq;
    });
}

export function wireId(bootId: string, seq: number): string {
  return `${bootId}-${seq}`;
}
