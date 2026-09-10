import { describe, it, expect } from 'vitest';
import { createAsyncEventQueue } from '../src/events/event-stream.js';

describe('AsyncEventQueue', () => {
  it('delivers pushed values in order then ends on close', async () => {
    const q = createAsyncEventQueue<number>();
    q.push(1);
    q.push(2);
    q.close();
    const out: number[] = [];
    for await (const v of q) out.push(v);
    expect(out).toEqual([1, 2]);
  });

  it('delivers values pushed AFTER the consumer is already awaiting', async () => {
    const q = createAsyncEventQueue<string>();
    const collected: string[] = [];
    const consumer = (async () => {
      for await (const v of q) collected.push(v);
    })();
    q.push('a');
    await Promise.resolve();
    q.push('b');
    q.close();
    await consumer;
    expect(collected).toEqual(['a', 'b']);
  });

  it('throws into the consumer when fail() is called', async () => {
    const q = createAsyncEventQueue<number>();
    q.push(1);
    q.fail(new Error('boom'));
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const v of q) seen.push(v);
      })(),
    ).rejects.toThrow('boom');
    expect(seen).toEqual([1]);
  });

  it('applies backpressure: push parks at the high-water mark and resumes as the consumer drains', async () => {
    // Bound of 2: the push that takes the buffer TO the mark parks until a consumer drains below it.
    const q = createAsyncEventQueue<number>({ highWaterMark: 2 });
    await q.push(0); // buffer 1 < 2 — resolves immediately
    let resumed = false;
    const parked = q.push(1).then(() => (resumed = true)); // buffer 2 >= 2 — parks
    await Promise.resolve();
    expect(resumed).toBe(false);
    const it = q[Symbol.asyncIterator]();
    await it.next(); // drains one -> buffer 1 < 2 -> the parked producer resolves
    await parked;
    expect(resumed).toBe(true);
  });
});
