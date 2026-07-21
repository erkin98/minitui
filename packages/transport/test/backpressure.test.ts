import { describe, it, expect } from 'vitest';
import { BoundedQueue } from '../src/bus/backpressure.js';
import { COALESCIBLE } from '../src/bus/topics.js';

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
});
