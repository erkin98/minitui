export interface Clock {
  now(): number; // milliseconds since the Unix epoch
  /**
   * Resolves after `ms` milliseconds, or as soon as `signal` aborts, and never rejects. A virtual clock
   * returns at once.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
    }),
};

export function fixedClock(ms: number): Clock {
  return { now: () => ms, sleep: () => Promise.resolve() };
}

export function steppingClock(startMs: number, stepMs: number): Clock {
  let t = startMs;
  return {
    now() {
      const cur = t;
      t += stepMs;
      return cur;
    },
    sleep: () => Promise.resolve(),
  };
}
