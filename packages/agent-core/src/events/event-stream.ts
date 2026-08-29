/** Push/close bridge: producers push, one consumer iterates. Drains buffered values before ending. */
export interface AsyncEventQueue<T> {
  /**
   * Enqueue a value. Delivery + order are guaranteed synchronously; the returned promise resolves
   * immediately while the buffer is below the high-water mark and PARKS the producer once it is at/above
   * it — a producer that `await`s gets backpressure (a bounded channel whose send blocks the producer
   * when the consumer lags). A caller that ignores the promise still never loses a value.
   */
  push(value: T): Promise<void>;
  close(): void;
  fail(err: unknown): void;
  [Symbol.asyncIterator](): AsyncIterator<T, undefined>;
}

/** Default queue high-water mark — the ceiling a fast model can't balloon the buffer past. */
export const DEFAULT_QUEUE_HIGH_WATER_MARK = 1024;

type Waiter<T> = (r: IteratorResult<T, undefined>) => void;

export function createAsyncEventQueue<T>(
  opts: { highWaterMark?: number } = {},
): AsyncEventQueue<T> {
  const highWaterMark = opts.highWaterMark ?? DEFAULT_QUEUE_HIGH_WATER_MARK;
  const buffer: T[] = [];
  const waiters: Array<{ resolve: Waiter<T>; reject: (e: unknown) => void }> = [];
  const drains: Array<() => void> = [];
  let closed = false;
  let failure: { err: unknown } | undefined;

  /** Wake parked producers once the buffer has drained back below the high-water mark. */
  const releaseDrains = () => {
    while (buffer.length < highWaterMark && drains.length > 0) {
      const resolve = drains.shift();
      resolve?.();
    }
  };

  return {
    push(value) {
      if (closed) return Promise.resolve();
      const w = waiters.shift();
      if (w) {
        w.resolve({ value, done: false });
        return Promise.resolve();
      }
      buffer.push(value);
      // At/above the mark, park the producer until the consumer drains below it (backpressure).
      if (buffer.length >= highWaterMark)
        return new Promise<void>((resolve) => drains.push(resolve));
      return Promise.resolve();
    },
    close() {
      if (closed) return;
      closed = true;
      for (const d of drains.splice(0)) d(); // never leave a producer parked on a closed queue
      for (const w of waiters.splice(0)) w.resolve({ value: undefined, done: true });
    },
    fail(err) {
      if (closed) return;
      closed = true;
      failure = { err };
      for (const d of drains.splice(0)) d();
      for (const w of waiters.splice(0)) w.reject(err);
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (buffer.length > 0) {
            const value = buffer.shift() as T;
            releaseDrains();
            return Promise.resolve({ value, done: false });
          }
          // Reject with the producer's fail() value verbatim: coercing to Error would run
          // String(err), which can itself throw, and would lose the caller's error identity
          // (mirrors transport's ag-ui-agent/local-agent throw() convention).
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          if (failure) return Promise.reject(failure.err);
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise<IteratorResult<T, undefined>>((resolve, reject) =>
            waiters.push({ resolve, reject }),
          );
        },
      };
    },
  };
}
