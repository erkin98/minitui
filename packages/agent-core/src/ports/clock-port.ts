export interface Clock {
  now(): number; // milliseconds since the Unix epoch
}

export const systemClock: Clock = { now: () => Date.now() };

export function fixedClock(ms: number): Clock {
  return { now: () => ms };
}

export function steppingClock(startMs: number, stepMs: number): Clock {
  let t = startMs;
  return {
    now() {
      const cur = t;
      t += stepMs;
      return cur;
    },
  };
}
