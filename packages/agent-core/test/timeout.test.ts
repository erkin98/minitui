import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withTimeout, withIdleTimeout } from '../src/guards/timeout.js';
import { rejectionRecorder } from './helpers/sdk-model.js';

describe('withTimeout', () => {
  it('aborts when the user signal aborts', () => {
    const ac = new AbortController();
    const sig = withTimeout(ac.signal, 10_000);
    expect(sig.aborted).toBe(false);
    ac.abort();
    expect(sig.aborted).toBe(true);
  });

  it('aborts when the deadline elapses', async () => {
    const sig = withTimeout(undefined, 5);
    await new Promise((r) => setTimeout(r, 20));
    expect(sig.aborted).toBe(true);
  });
});

describe('withIdleTimeout', () => {
  it('throws onIdle when the source stalls past the deadline, after yielding what arrived', async () => {
    async function* stalls() {
      yield 1;
      await new Promise<void>(() => {}); // silent forever — the idle deadline must break this
    }
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const v of withIdleTimeout(stalls(), 10, () => new Error('idle'))) seen.push(v);
      })(),
    ).rejects.toThrow('idle');
    expect(seen).toEqual([1]);
  });

  it('passes values through untouched while the source keeps up', async () => {
    async function* quick() {
      yield 1;
      yield 2;
    }
    const seen: number[] = [];
    for await (const v of withIdleTimeout(quick(), 1000, () => new Error('idle'))) seen.push(v);
    expect(seen).toEqual([1, 2]);
  });
});

describe('withIdleTimeout releases its source', () => {
  const recorder = rejectionRecorder();
  beforeEach(() => recorder.attach());
  afterEach(() => recorder.detach());

  type Release = 'resolves' | 'rejects' | 'throws';
  function counted(
    values: readonly number[],
    end: 'done' | 'hang' | 'reject',
    release: Release,
  ): { readonly iterable: AsyncIterable<number>; readonly returns: () => number } {
    let returned = 0;
    let index = 0;
    const iterator: AsyncIterator<number> = {
      next() {
        const value = values[index];
        if (value !== undefined) {
          index += 1;
          return Promise.resolve({ value, done: false });
        }
        if (end === 'done') return Promise.resolve({ value: undefined, done: true });
        if (end === 'reject') return Promise.reject(new Error('source failed'));
        return new Promise<IteratorResult<number>>(() => {});
      },
      return() {
        returned += 1;
        if (release === 'throws') throw new Error('release threw');
        return release === 'resolves'
          ? Promise.resolve({ value: undefined, done: true })
          : Promise.reject(new Error('release failed'));
      },
    };
    return { iterable: { [Symbol.asyncIterator]: () => iterator }, returns: () => returned };
  }

  describe.each<Release>(['resolves', 'rejects'])('when return() %s', (release) => {
    it('does not release a source that reported done', async () => {
      const src = counted([1, 2], 'done', release);
      const seen: number[] = [];
      for await (const v of withIdleTimeout(src.iterable, 1000, () => new Error('idle'))) {
        seen.push(v);
      }
      await recorder.settle();
      expect(seen).toEqual([1, 2]);
      expect(src.returns()).toBe(0);
      expect(recorder.seen).toEqual([]);
    });

    it('releases once when the idle deadline fires', async () => {
      const src = counted([1], 'hang', release);
      await expect(
        (async () => {
          for await (const _ of withIdleTimeout(src.iterable, 20, () => new Error('idle'))) {
            /* drain */
          }
        })(),
      ).rejects.toThrow('idle');
      await recorder.settle();
      expect(src.returns()).toBe(1);
      expect(recorder.seen).toEqual([]);
    });

    it('releases once when the consumer breaks out', async () => {
      const src = counted([1, 2, 3], 'done', release);
      for await (const _ of withIdleTimeout(src.iterable, 1000, () => new Error('idle'))) break;
      await recorder.settle();
      expect(src.returns()).toBe(1);
      expect(recorder.seen).toEqual([]);
    });

    it("releases once when the consumer's loop body throws", async () => {
      const src = counted([1, 2], 'done', release);
      await expect(
        (async () => {
          for await (const _ of withIdleTimeout(src.iterable, 1000, () => new Error('idle'))) {
            throw new Error('body failed');
          }
        })(),
      ).rejects.toThrow('body failed');
      await recorder.settle();
      expect(src.returns()).toBe(1);
      expect(recorder.seen).toEqual([]);
    });

    it("releases once when the source's own next() rejects", async () => {
      const src = counted([1], 'reject', release);
      await expect(
        (async () => {
          for await (const _ of withIdleTimeout(src.iterable, 1000, () => new Error('idle'))) {
            /* drain */
          }
        })(),
      ).rejects.toThrow('source failed');
      await recorder.settle();
      expect(src.returns()).toBe(1);
      expect(recorder.seen).toEqual([]);
    });
  });

  it('swallows a return() that throws synchronously', async () => {
    const src = counted([1], 'hang', 'throws');
    await expect(
      (async () => {
        for await (const _ of withIdleTimeout(src.iterable, 20, () => new Error('idle'))) {
          /* drain */
        }
      })(),
    ).rejects.toThrow('idle');
    await recorder.settle();
    expect(src.returns()).toBe(1);
  });
});
