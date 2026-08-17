import { describe, it, expect } from 'vitest';
import { BoundedQueue } from '../src/bus/backpressure.js';
import { COALESCIBLE, POSITIONAL, type Topic } from '../src/bus/topics.js';

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

  it('preserves FIFO order while the ring wraps and releases cleared entries', () => {
    const q = new BoundedQueue<number>(3, false);
    q.push(1);
    q.push(2);
    q.push(3);
    expect(q.dequeue()?.value).toBe(1);
    q.push(4);
    expect(q.size).toBe(3);
    expect(q.drain()).toEqual([2, 3, 4]);
    expect(q.size).toBe(0);

    q.push(5);
    q.clear();
    expect(q.dequeue()).toBeUndefined();
    expect(q.size).toBe(0);
  });

  it('preserves an undefined payload when draining', () => {
    const q = new BoundedQueue<undefined>(2, false);
    q.push(undefined);

    expect(q.drain()).toEqual([undefined]);
  });

  it('preserves an undefined payload when dequeuing, not only when draining', () => {
    // `drain()` keeps the entry wrapper and so distinguishes a stored `undefined` payload from
    // the empty-queue sentinel; `dequeue()` unwrapped it and lost that distinction, on the same
    // publicly exported generic class. The obligation is a property of the class, not of one
    // removal method, so the two must agree.
    const q = new BoundedQueue<undefined>(2, false);
    q.push(undefined);

    expect(q.dequeue()).toEqual({ value: undefined });
    expect(q.dequeue()).toBeUndefined(); // now empty: the sentinel, not a payload
  });

  it('state-delta is NOT in the coalescible set', () => {
    expect(COALESCIBLE.has('state-delta')).toBe(false);
    expect(COALESCIBLE.has('token')).toBe(true);
    expect(COALESCIBLE.has('content')).toBe(true);
    expect(COALESCIBLE.has('visibility')).toBe(true);
  });

  it('COALESCIBLE is immutable at runtime', () => {
    // The ReadonlySet type is compile-time only; if a runtime cast-escape added 'state-delta',
    // state deltas would start coalescing and drop intermediate RFC-6902 patches, corrupting state.
    expect(() => (COALESCIBLE as Set<Topic>).add('state-delta')).toThrow();
    expect(COALESCIBLE.has('state-delta')).toBe(false);
  });

  it('rejects borrowed native Set mutation methods', () => {
    const runtime = COALESCIBLE as Set<Topic>;
    expect(() => Set.prototype.add.call(runtime, 'state-delta')).toThrow();
    expect(() => Set.prototype.delete.call(runtime, 'token')).toThrow();
    expect(() => Set.prototype.clear.call(runtime)).toThrow();
    expect(COALESCIBLE.has('state-delta')).toBe(false);
    expect(COALESCIBLE.has('token')).toBe(true);
  });

  it('POSITIONAL contains exactly state-delta', () => {
    expect(POSITIONAL.has('state-delta')).toBe(true);
    expect(POSITIONAL.has('token')).toBe(false);
    expect(POSITIONAL.has('content')).toBe(false);
    expect(POSITIONAL.has('visibility')).toBe(false);
    expect(POSITIONAL.has('run-status')).toBe(false);
    expect(POSITIONAL.has('error')).toBe(false);
    expect(POSITIONAL.has('action')).toBe(false);
  });

  it('POSITIONAL is immutable at runtime', () => {
    // Same rationale as COALESCIBLE's runtime guard: a cast-escape here would let a positional
    // topic quietly lose the non-lossy guarantee this file exists to provide.
    expect(() => (POSITIONAL as Set<Topic>).add('token')).toThrow();
    expect(POSITIONAL.has('token')).toBe(false);
  });

  it('POSITIONAL rejects borrowed native Set mutation methods', () => {
    const runtime = POSITIONAL as Set<Topic>;
    expect(() => Set.prototype.add.call(runtime, 'token')).toThrow();
    expect(() => Set.prototype.delete.call(runtime, 'state-delta')).toThrow();
    expect(() => Set.prototype.clear.call(runtime)).toThrow();
    expect(POSITIONAL.has('state-delta')).toBe(true);
    expect(POSITIONAL.has('token')).toBe(false);
  });
});

describe('BoundedQueue lossy=false (positional-patch topics, e.g. state-delta)', () => {
  it('stops growing at its ceiling and latches a gap instead of exhausting memory', () => {
    // Unbounded growth turns a stuck consumer into an OOM crash. Past the ceiling the queue
    // starts dropping and latches `gapped`, so the consumer knows the positional sequence is
    // no longer contiguous and must resync rather than apply an incomplete stream.
    const q = new BoundedQueue<number>(4, false, false);
    expect(q.gapped).toBe(false);
    for (let i = 0; i < 100_000; i += 1) q.push(i);
    expect(q.gapped).toBe(true);
    expect(q.dropped).toBeGreaterThan(0);
    expect(q.size).toBeLessThanOrEqual(4 * 64); // bounded, not 100_000
  });

  it('does not latch a gap while growth is still within the ceiling', () => {
    const q = new BoundedQueue<number>(4, false, false);
    for (let i = 0; i < 50; i += 1) q.push(i);
    expect(q.gapped).toBe(false);
    expect(q.dropped).toBe(0);
    expect(q.drain()).toHaveLength(50); // every operation preserved
  });

  it('clears a latched gap when the queue is cleared', () => {
    const q = new BoundedQueue<number>(2, false, false);
    for (let i = 0; i < 10_000; i += 1) q.push(i);
    expect(q.gapped).toBe(true);
    q.clear();
    expect(q.gapped).toBe(false);
  });

  it('never drops a queued operation once capacity is exceeded', () => {
    // Simulates a state-delta subscriber falling behind a fast publisher: capacity is 3 but 50
    // RFC-6902 operations get queued. Every one must still be delivered, in order — the old
    // overwrite-oldest policy would silently drop the first 47 and hand the consumer a document
    // corrupted by a gap instead of a detected one.
    const q = new BoundedQueue<number>(3, false, false);
    for (let i = 1; i <= 50; i += 1) q.push(i);
    expect(q.drain()).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(q.dropped).toBe(0);
  });

  it('refuses the incoming item at its ceiling and never evicts a queued one', () => {
    // Overwriting the head at the ceiling is exactly the lossy policy this queue exists to
    // avoid: it discards the OLDEST operations of a positional sequence, so the consumer
    // applies a window whose start it never saw. Refusing the NEWEST keeps the queued prefix
    // contiguous from the first admitted item and puts the discontinuity at the tail, where a
    // resync snapshot fits cleanly. The four ceiling tests above assert the counters and the
    // bound but never the drained window, which is why the eviction shipped unnoticed.
    const q = new BoundedQueue<number>(2, false, false); // ceiling = 2 * 64 = 128
    for (let i = 1; i <= 200; i += 1) q.push(i);
    expect(q.gapped).toBe(true);
    expect(q.dropped).toBe(72); // 200 pushed - 128 admitted
    expect(q.drain()).toEqual(Array.from({ length: 128 }, (_, i) => i + 1)); // [1..128], not [73..200]
  });

  it('preserves FIFO order across a growth that happens while the ring is wrapped', () => {
    const q = new BoundedQueue<string>(3, false, false);
    q.push('a');
    q.push('b');
    q.push('c');
    expect(q.dequeue()?.value).toBe('a');
    q.push('d'); // refills the slot dequeue() freed; head is now non-zero
    q.push('e'); // exceeds capacity with a non-zero head — must grow, not evict
    q.push('f');
    expect(q.drain()).toEqual(['b', 'c', 'd', 'e', 'f']);
    expect(q.dropped).toBe(0);
  });

  it('does not affect the coalescing path', () => {
    const q = new BoundedQueue<string>(8, true, false);
    q.push('x');
    q.push('y');
    q.push('z');
    expect(q.drain()).toEqual(['z']);
  });

  it('clear() resets any capacity growth back to the configured minimum', () => {
    const q = new BoundedQueue<number>(2, false, false);
    q.push(1);
    q.push(2);
    q.push(3);
    q.push(4); // forces growth past the configured capacity of 2
    q.clear();
    q.push(5);
    q.push(6);
    expect(q.drain()).toEqual([5, 6]);
  });

  it('defaulting the third argument reproduces the original lossy overwrite-oldest behavior', () => {
    // Regression guard: every existing (capacity, coalesce) call site must see byte-identical
    // behavior when it does not opt into lossy=false.
    const q = new BoundedQueue<number>(2, false);
    q.push(1);
    q.push(2);
    q.push(3);
    expect(q.drain()).toEqual([2, 3]);
    expect(q.dropped).toBe(1);
  });
});

describe('BoundedQueue capacity validation', () => {
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
