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

export class BoundedQueue<T> {
  private items: T[] = [];
  private droppedCount = 0;
  constructor(
    private readonly capacity: number,
    private readonly coalesce: boolean,
  ) {
    assertValidCapacity(capacity);
  }

  push(item: T): void {
    if (this.coalesce) {
      this.items = [item];
      return;
    }
    this.items.push(item);
    while (this.items.length > this.capacity) {
      this.items.shift();
      this.droppedCount += 1;
    }
  }

  drain(): T[] {
    const out = this.items;
    this.items = [];
    return out;
  }

  get dropped(): number {
    return this.droppedCount;
  }
}
