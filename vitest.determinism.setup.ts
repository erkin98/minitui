// vitest.determinism.setup.ts
// Loaded by vitest.shared.ts setupFiles. Makes every test run byte-deterministic
// so golden .ansi snapshots are stable across machines and CI runners.

import { FROZEN_EPOCH_MS } from './vitest.determinism.constants';

// wiring sentinel: proves this module ran via setupFiles (removing setupFiles from
// vitest.shared.ts makes the sentinel absent → the determinism test reds).
globalThis.__MINITUI_DET_SETUP__ = true;

// lock timezone + locale BEFORE any Date is constructed
process.env.TZ = 'UTC';
process.env.LC_ALL = 'C';

// pin COLUMNS/LINES for PTY/CLI tests that read process.env — NOT for Ink goldens, which
// render at ink-testing-library's fixed 100 columns (test-kit's FROZEN_SIZE, a later plan)
process.env.COLUMNS = '80';
process.env.LINES = '24';
process.env.FORCE_COLOR = '1';

// freeze the clock
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: ConstructorParameters<typeof RealDate>) {
    if (args.length === 0) {
      super(FROZEN_EPOCH_MS);
    } else {
      super(...args);
    }
  }
  static now(): number {
    return FROZEN_EPOCH_MS;
  }
}
globalThis.Date = FrozenDate as DateConstructor;

// deterministic PRNG (mulberry32) replacing Math.random — seeded, reproducible
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seededRandom = mulberry32(0x1234abcd);
Math.random = seededRandom;
