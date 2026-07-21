export class BoundedQueue<T> {
  private items: T[] = [];
  private droppedCount = 0;
  constructor(
    private readonly capacity: number,
    private readonly coalesce: boolean,
  ) {}

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
