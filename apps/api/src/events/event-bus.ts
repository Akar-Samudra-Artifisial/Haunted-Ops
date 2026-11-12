import { randomBytes } from 'node:crypto';
import {
  BOOT_ID_PATTERN,
  validateSseEvent,
  type DomainEventName,
  type DomainEventPayloads,
} from '@haunted-ops/shared';
import { RING_CAPACITY, RingBuffer, type BusEvent } from './ring-buffer.js';

export type { BusEvent };
export type Subscriber = (event: BusEvent) => void;

/** A fresh random boot id: 12 lowercase hex characters. */
export function newBootId(): string {
  return randomBytes(6).toString('hex');
}

/**
 * In-process event bus. Assigns strictly increasing integer sequence numbers,
 * keeps the newest events in a ring buffer and fans out to subscribers. No Redis.
 * Sequence numbers restart with the process, so every process has its own random
 * boot id and the wire id is `<bootId>-<seq>`: an id from another boot always resyncs.
 */
export class EventBus {
  readonly buffer: RingBuffer;
  readonly bootId: string;
  private counter = 0;
  private readonly subscribers = new Set<Subscriber>();
  private closed = false;

  constructor(options: { capacity?: number; bootId?: string } = {}) {
    this.buffer = new RingBuffer(options.capacity ?? RING_CAPACITY);
    const bootId = options.bootId ?? newBootId();
    if (!BOOT_ID_PATTERN.test(bootId)) throw new RangeError('bootId must be 12 lowercase hex characters');
    this.bootId = bootId;
  }

  /** Validates the payload with the shared validator, then stores and fans out. */
  publish<K extends DomainEventName>(name: K, payload: DomainEventPayloads[K]): BusEvent {
    if (this.closed) throw new Error('event bus is closed');
    const check = validateSseEvent(name, payload);
    if (!check.ok) throw new TypeError(`invalid payload for ${name}: ${check.errors.join(', ')}`);
    const event: BusEvent = Object.freeze({ id: ++this.counter, name, payload });
    this.buffer.push(event);
    for (const fn of [...this.subscribers]) {
      try {
        fn(event);
      } catch {
        // A failing subscriber (for example a closed socket) must not affect the others.
        this.subscribers.delete(fn);
      }
    }
    return event;
  }

  /** Returns the unsubscribe function. */
  subscribe(fn: Subscriber): () => void {
    if (this.closed) return () => undefined;
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
    this.subscribers.clear();
  }
}
