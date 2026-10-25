import { describe, expect, it } from 'vitest';
import { hasCanonicalKeys, runFullValidation, videoMergeCatalog } from '../src/index.js';
import type { AppSpec } from '../src/index.js';

// How the cost of the catalog's checks grows with the size of a spec. A stopwatch bound with a thin
// margin has already failed a push, so a row compares the fastest run at the full size with the fastest
// run at a fraction of it: linear work grows about `shrink` times, quadratic work about `shrink`
// squared, and a busy machine slows both sizes alike.

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

// one Box holding `count` Text children
function boxOf(count: number): AppSpec {
  const elements: Record<string, AppSpec['elements'][string]> = {
    root: { type: 'Box', props: {}, children: Array.from({ length: count }, (_, i) => `t${i}`) },
  };
  for (let i = 0; i < count; i++) elements[`t${i}`] = { type: 'Text', props: { text: 'x' } };
  return { root: 'root', elements };
}

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

describe('the checks of a spec', () => {
  it('the key predicate grows in proportion to the number of elements', () => {
    const ratio = growth((count) => {
      const spec = boxOf(count);
      return () => {
        sinks.push(hasCanonicalKeys(spec));
      };
    }, 20_000);
    expect(ratio).toBeLessThan(BOUND);
  });

  it('the full validation grows in proportion to the number of elements', () => {
    const ratio = growth(
      (count) => {
        const spec = boxOf(count);
        return () => {
          sinks.push(runFullValidation(spec, videoMergeCatalog, {}));
        };
      },
      1_000,
      8,
      3,
    );
    expect(ratio).toBeLessThan(BOUND);
  }, 120_000);
});
