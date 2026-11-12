import type { DomainEventName } from '@haunted-ops/shared';

export interface BusEvent {
  readonly id: number;
  readonly name: DomainEventName;
  readonly payload: unknown;
}

export const RING_CAPACITY = 500;

/** Fixed-size circular store of the newest events, used for SSE resume. */
export class RingBuffer {
  private readonly slots: (BusEvent | undefined)[];
  private start = 0;
  private size = 0;
  private latest = 0;

  constructor(readonly capacity: number = RING_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
    this.slots = new Array<BusEvent | undefined>(capacity);
  }

  /** Stores an event, dropping the oldest when full. Ids must increase. */
  push(event: BusEvent): void {
    if (event.id <= this.latest) throw new RangeError('event ids must increase');
    if (this.size < this.capacity) {
      this.slots[(this.start + this.size) % this.capacity] = event;
      this.size++;
    } else {
      this.slots[this.start] = event;
      this.start = (this.start + 1) % this.capacity;
    }
    this.latest = event.id;
  }

  get length(): number {
    return this.size;
  }

  oldestId(): number | null {
    return this.size === 0 ? null : (this.slots[this.start] as BusEvent).id;
  }

  latestId(): number {
    return this.latest;
  }

  /** All retained events, oldest first. */
  toArray(): BusEvent[] {
    const out: BusEvent[] = [];
    for (let i = 0; i < this.size; i++) out.push(this.slots[(this.start + i) % this.capacity] as BusEvent);
    return out;
  }

  /**
   * Events with id greater than lastId, oldest first.
   * 'ahead' when lastId is past the latest id (for example after an API restart),
   * 'too_old' when events after lastId were already dropped.
   */
  since(lastId: number): BusEvent[] | 'too_old' | 'ahead' {
    if (lastId > this.latest) return 'ahead';
    const oldest = this.oldestId();
    if (oldest === null) return [];
    if (lastId < oldest - 1) return 'too_old';
    return this.toArray().filter((e) => e.id > lastId);
  }
}
