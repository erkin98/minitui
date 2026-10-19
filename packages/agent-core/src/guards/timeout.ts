/** Compose the user abort with a deadline: Esc OR timeout aborts the returned signal. */
export function withTimeout(userSignal: AbortSignal | undefined, ms: number): AbortSignal {
  const deadline = AbortSignal.timeout(ms);
  return userSignal ? AbortSignal.any([userSignal, deadline]) : deadline;
}

// Release a source that did not finish. The release is not awaited (a source stalled forever would never
// settle return(); the real stream is torn down by the turn's AbortSignal), but its outcome is always
// handled: a rejected release, or one that throws synchronously, must not become an unhandled rejection.
function release(iterator: AsyncIterator<unknown>): void {
  try {
    void Promise.resolve(iterator.return?.()).catch(() => {});
  } catch {
    /* a release that throws synchronously changes nothing for the consumer */
  }
}

/**
 * Wrap an async iterable so each pull is raced against an idle deadline: if the source produces no
 * next value within `ms`, throw `onIdle()`. An AbortSignal covers the whole turn but never a
 * silently-stalled stream, so this guards the per-chunk gap the way a bounded per-read timeout does.
 * The timer runs ONLY while awaiting the source, so a slow downstream consumer (queue backpressure)
 * between yields does not trip it.
 *
 * The source is released exactly once on every exit except the source reporting done: the idle
 * deadline, the consumer breaking out, the consumer's loop body throwing, and the source's own next()
 * rejecting. An iterable handed to this wrapper must tolerate return() once on early exit; it is never
 * given one after it reported done.
 */
export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  ms: number,
  onIdle: () => Error,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let finished = false;
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onIdle()), ms);
      });
      let result: IteratorResult<T>;
      try {
        result = await Promise.race([iterator.next(), idle]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (result.done) {
        finished = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (!finished) release(iterator);
  }
}
