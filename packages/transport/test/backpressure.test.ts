import { describe, it, expect } from 'vitest';
import { BoundedQueue } from '../src/bus/backpressure.js';
import { COALESCIBLE, type Topic } from '../src/bus/topics.js';

describe('BoundedQueue', () => {
  it('coalesces to the LATEST item when coalesce=true', () => {
    const q = new BoundedQueue<string>(8, true);
    q.push('a');
    q.push('b');
    q.push('c');
    expect(q.drain()).toEqual(['c']);
  });

  it('preserves order and every item when coalesce=false (state deltas)', () => {
    const q = new BoundedQueue<number>(8, false);
    q.push(1);
    q.push(2);
    q.push(3);
    expect(q.drain()).toEqual([1, 2, 3]);
  });

  it('drops oldest and counts drops past capacity when not coalescing', () => {
    const q = new BoundedQueue<number>(2, false);
    q.push(1);
    q.push(2);
    q.push(3);
    expect(q.drain()).toEqual([2, 3]);
    expect(q.dropped).toBe(1);
  });

  it('state-delta is NOT in the coalescible set', () => {
    expect(COALESCIBLE.has('state-delta')).toBe(false);
    expect(COALESCIBLE.has('token')).toBe(true);
    expect(COALESCIBLE.has('content')).toBe(true);
    expect(COALESCIBLE.has('visibility')).toBe(true);
  });

  it('COALESCIBLE is immutable at runtime — a cast-escape cannot add state-delta (C17)', () => {
    // The ReadonlySet type is compile-time only; if a runtime cast-escape added 'state-delta',
    // state deltas would start coalescing and drop intermediate RFC-6902 patches, corrupting state.
    expect(() => (COALESCIBLE as Set<Topic>).add('state-delta')).toThrow();
    expect(COALESCIBLE.has('state-delta')).toBe(false);
  });
});

describe('BoundedQueue capacity validation (C02)', () => {
  it('rejects a negative capacity that would hang the push loop forever', () => {
    // push()'s `while (items.length > capacity)` never terminates for capacity < 0 once the
    // array empties (0 > -1 stays true) — a synchronous, unrecoverable process hang. Reject early.
    expect(() => new BoundedQueue<number>(-1, false)).toThrow(RangeError);
  });

  it('rejects NaN capacity that would disable the bound entirely', () => {
    // Every comparison with NaN is false, so the drop loop never runs → unbounded growth.
    expect(() => new BoundedQueue<number>(Number.NaN, false)).toThrow(RangeError);
  });

  it('rejects zero capacity (contradictory FIFO-vs-coalesce semantics)', () => {
    expect(() => new BoundedQueue<number>(0, false)).toThrow(RangeError);
  });

  it('rejects a non-integer or infinite capacity', () => {
    expect(() => new BoundedQueue<number>(1.5, false)).toThrow(RangeError);
    expect(() => new BoundedQueue<number>(Number.POSITIVE_INFINITY, false)).toThrow(RangeError);
  });

  it('accepts a valid positive integer capacity', () => {
    expect(() => new BoundedQueue<number>(1, false)).not.toThrow();
    expect(() => new BoundedQueue<number>(256, true)).not.toThrow();
  });
});
