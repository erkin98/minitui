/**
 * A queue capacity must be a positive integer. A non-positive or non-finite value breaks the
 * drop loop below: `capacity < 0` spins forever once `items` empties (`0 > -1` stays true),
 * `NaN`/`Infinity` disables the bound entirely (every comparison is false), and `0` gives FIFO
 * and coalescing topics contradictory semantics. Validate once at construction — fail closed.
 */
export function assertValidCapacity(capacity: number): void {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`bounded-queue capacity must be a positive integer, got ${capacity}`);
  }
}

// A non-lossy queue may grow to this multiple of its configured capacity before it starts
// reporting a gap. Bounded so a stuck consumer degrades to a reported gap, not an OOM.
const MAX_GROWTH_FACTOR = 64;

export class BoundedQueue<T> {
  private slots: Array<{ readonly value: T } | undefined> = [];
  private head = 0;
  private count = 0;
  private droppedCount = 0;
  private gapDetected = false;
  private ringCapacity: number;

  /**
   * `lossy` (default `true`) reproduces the original overwrite-oldest behavior exactly: once
   * `count` reaches `capacity`, the oldest queued item is evicted to make room. That is only
   * safe for a topic whose values supersede one another. RFC-6902 deltas apply positionally
   * against one evolving document — evicting any queued operation, oldest or not, corrupts
   * every later apply, so a positional-patch queue is constructed with `lossy: false`: instead
   * of evicting, the ring grows (amortized doubling, same as a dynamic array). Growth is capped
   * at `MAX_GROWTH_FACTOR` times the configured capacity — past that the queue refuses the
   * INCOMING item and latches `gapped`, because reporting a gap the consumer can resync from
   * beats exhausting memory. It still never evicts a queued one, at any volume.
   */
  constructor(
    private readonly capacity: number,
    private readonly coalesce: boolean,
    private readonly lossy: boolean = true,
  ) {
    assertValidCapacity(capacity);
    this.ringCapacity = capacity;
  }

  push(item: T): void {
    if (this.coalesce) {
      if (this.count === 0) {
        this.head = 0;
        this.count = 1;
      }
      this.slots[this.head] = { value: item };
      return;
    }
    if (this.count >= this.ringCapacity) {
      if (!this.lossy) {
        if (this.ringCapacity >= this.capacity * MAX_GROWTH_FACTOR) {
          // At its ceiling a non-lossy queue REFUSES the incoming item — `slots`, `head` and
          // `count` are untouched, so the queued prefix stays contiguous from the first
          // admitted item and the discontinuity lands at the tail, where a resync snapshot
          // fits. Evicting the head here instead would be the lossy overwrite-oldest policy
          // this queue exists to avoid, on the operations a positional consumer already
          // needs. Latch the gap so the consumer learns the sequence is truncated.
          this.gapDetected = true;
          this.droppedCount += 1;
          return;
        }
        this.grow();
      } else {
        this.slots[this.head] = { value: item };
        this.head = (this.head + 1) % this.ringCapacity;
        this.droppedCount += 1;
        return;
      }
    }
    const tail = (this.head + this.count) % this.ringCapacity;
    this.slots[tail] = { value: item };
    this.count += 1;
  }

  /**
   * Re-linearizes the ring from `head` into a doubled backing array. Amortized O(1) per push.
   * Growth is bounded: an unbounded ring turns a stuck consumer into an out-of-memory crash,
   * which is a worse failure than a reported gap. At the ceiling the queue stops growing and
   * starts refusing incoming items, and `gapped` latches so the consumer learns its sequence is
   * truncated at the tail and can resync instead of applying an incomplete stream.
   */
  private grow(): void {
    const linear: Array<{ readonly value: T } | undefined> = [];
    for (let i = 0; i < this.count; i += 1) {
      linear.push(this.slots[(this.head + i) % this.ringCapacity]);
    }
    this.ringCapacity *= 2;
    this.slots = linear;
    this.head = 0;
  }

  /** True once a non-lossy queue has hit its growth ceiling and begun dropping. Latches. */
  get gapped(): boolean {
    return this.gapDetected;
  }

  /**
   * Returns the entry WRAPPER, not the bare payload: on a `BoundedQueue<undefined>` an unwrapped
   * return cannot distinguish a stored `undefined` payload from the empty-queue sentinel, and
   * `drain()` already relies on that distinction. Both removal paths keep it.
   */
  dequeue(): { readonly value: T } | undefined {
    if (this.count === 0) return undefined;
    const entry = this.slots[this.head];
    this.slots[this.head] = undefined;
    this.count -= 1;
    if (this.count === 0) {
      this.head = 0;
      this.slots.length = 0;
    } else {
      this.head = (this.head + 1) % this.ringCapacity;
    }
    return entry;
  }

  drain(): T[] {
    const out: T[] = [];
    while (this.count > 0) {
      const entry = this.dequeue();
      if (entry !== undefined) out.push(entry.value);
    }
    return out;
  }

  clear(): void {
    this.slots.length = 0;
    this.head = 0;
    this.count = 0;
    this.ringCapacity = this.capacity;
    this.gapDetected = false;
  }

  get size(): number {
    return this.count;
  }

  get dropped(): number {
    return this.droppedCount;
  }
}
