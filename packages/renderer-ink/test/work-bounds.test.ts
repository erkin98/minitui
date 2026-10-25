import { describe, expect, it } from 'vitest';
import type { JsonPatch, RuntimeFault } from '@minitui/types';
import { refusalLine } from '../src/binder/refusal-line.js';
import { applyStatePatchTo } from '../src/state-patch.js';
import { layoutConsent } from '../src/widgets/consent-layout.js';
import { displayText } from '../src/widgets/display-text.js';
import { controlledIo } from './support/store-io.js';

// How the cost of each shaped-text sink of this package grows with its input. A stopwatch bound with a
// thin margin has already failed a push, so a row compares the fastest run at the full size with the
// fastest run at a fraction of it: linear work grows about `shrink` times, quadratic work about `shrink`
// squared, and a busy machine slows both sizes alike. A row keeps an absolute bound only where the bound
// is far above the worst time measured under load.

// results are kept so that no run can be dropped as dead code
const sinks: unknown[] = [];

// The fastest of `runs` runs in milliseconds: contention and a cold first call can only slow a run,
// never speed it up.
function fastest(run: () => void, runs = 5): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

// The growth of a run from `full / shrink` to `full`. A timer cannot tell below 0.2 ms.
function growth(build: (size: number) => () => void, full: number, shrink = 8, runs = 5): number {
  return fastest(build(full), runs) / Math.max(fastest(build(full / shrink), runs), 0.2);
}

const BOUND = 24; // three times the growth of linear work at a shrink of 8

describe('the growth measure', () => {
  it('tells quadratic work from linear work', () => {
    const linear = (n: number) => (): void => {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += i;
      sinks.push(sum);
    };
    const quadratic = (n: number) => (): void => {
      const items = Array.from({ length: n }, (_, i) => i);
      let found = 0;
      for (const item of items) found += items.indexOf(item);
      sinks.push(found);
    };
    // 32,000 against 2,000: a planted quadratic reads 76 or more even beside 32 busy loops under
    // coverage (the smaller 16,000 against 2,000 read as low as 18), a linear function under 5
    expect(growth(linear, 32_000, 16)).toBeLessThan(BOUND);
    expect(growth(quadratic, 32_000, 16)).toBeGreaterThan(BOUND);
  }, 120_000);
});

describe('the state patch', () => {
  it('patch operations cost time in proportion to their number on an 8,000-node state', () => {
    const seed = { list: Array.from({ length: 8_000 }, (_, i) => i) };
    const ratio = growth((operations) => {
      const patch: JsonPatch[] = Array.from({ length: operations }, (_, i) => ({
        op: 'add',
        path: `/k${i}`,
        value: i,
      }));
      return () => {
        applyStatePatchTo(controlledIo(seed), patch);
      };
    }, 256);
    expect(ratio).toBeLessThan(BOUND);
  }, 120_000);

  it('one patch pointer of 1,000,000 characters is parsed in under 5 s', () => {
    const patch: JsonPatch[] = [{ op: 'add', path: `/${'k'.repeat(1_000_000)}`, value: 1 }];
    const started = performance.now();
    applyStatePatchTo(controlledIo({}), patch);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe('the text the app frame draws', () => {
  it('the consent layout of a request 100 times the engine budget finishes in under 10 s', () => {
    const parts = {
      headline: 'Merge 2 videos',
      command: 'ffmpeg -i in.mp4 '.repeat(24_100).slice(0, 409_600),
      paths: Array.from({ length: 3_200 }, (_, i) => `/work/${i}/`.padEnd(1_024, 'p')),
    };
    const started = performance.now();
    layoutConsent(parts, 80, 24);
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it('the display strip of 1,000,000 characters finishes in under 5 s', () => {
    const hidden = String.fromCharCode(0x202e);
    const text = `ab${hidden}\r`.repeat(250_000);
    const started = performance.now();
    const shown = displayText(text);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(shown).toHaveLength(500_000);
  });

  it('the refusal line grows in proportion to the excerpt', () => {
    const faultOf = (size: number): RuntimeFault => ({
      actionKey: 'merge',
      exitCode: 1,
      stderrExcerpt: 'line\tof\ntext '.repeat(Math.ceil(size / 13)).slice(0, size),
    });
    const ratio = growth((size) => {
      const fault = faultOf(size);
      return () => {
        sinks.push(refusalLine('merge', fault));
      };
    }, 1_000_000);
    expect(ratio).toBeLessThan(BOUND);
  });
});
