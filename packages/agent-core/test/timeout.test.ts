import { describe, it, expect } from 'vitest';
import { withTimeout, withIdleTimeout } from '../src/guards/timeout.js';

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
