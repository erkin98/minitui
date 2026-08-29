/** Compose the user abort with a deadline: Esc OR timeout aborts the returned signal. */
export function withTimeout(userSignal: AbortSignal | undefined, ms: number): AbortSignal {
  const deadline = AbortSignal.timeout(ms);
  return userSignal ? AbortSignal.any([userSignal, deadline]) : deadline;
}

/**
 * Wrap an async iterable so each pull is raced against an idle deadline: if the source produces no
 * next value within `ms`, throw `onIdle()`. An AbortSignal covers the whole turn but never a
 * silently-stalled stream, so this guards the per-chunk gap the way a bounded per-read timeout does.
 * The timer runs ONLY while awaiting the source, so a slow downstream consumer (queue backpressure)
 * between yields does not trip it.
 */
export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  ms: number,
  onIdle: () => Error,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
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
      if (result.done) return;
      yield result.value;
    }
  } finally {
    // Best-effort release of the underlying iterator on throw/early-exit. Not awaited: a source
    // stalled forever would never settle return(), and the real stream is torn down by the turn's
    // AbortSignal.
    void iterator.return?.();
  }
}
