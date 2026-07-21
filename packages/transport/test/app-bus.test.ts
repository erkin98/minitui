import { describe, it, expect } from 'vitest';
import { createAppBus } from '../src/bus/app-bus.js';

describe('AppBus', () => {
  it('delivers a published payload to a topic subscriber', () => {
    const bus = createAppBus();
    const seen: string[] = [];
    bus.subscribe('content', (p) => seen.push(p));
    bus.publish('content', 'hello');
    expect(seen).toEqual(['hello']);
  });

  it('isolates topics — a token subscriber never sees content', () => {
    const bus = createAppBus();
    let tokens = 0;
    bus.subscribe('token', () => {
      tokens++;
    });
    bus.publish('content', 'x');
    expect(tokens).toBe(0);
  });

  it('delivers every state-delta in order (never coalesced)', () => {
    const bus = createAppBus();
    const deltas: unknown[] = [];
    bus.subscribe('state-delta', (p) => deltas.push(p.delta));
    bus.publish('state-delta', { delta: [{ op: 'add', path: '/a', value: 1 }] });
    bus.publish('state-delta', { delta: [{ op: 'add', path: '/b', value: 2 }] });
    expect(deltas).toHaveLength(2);
  });

  it('unsubscribe stops further delivery', () => {
    const bus = createAppBus();
    let errors = 0;
    const off = bus.subscribe('error', () => {
      errors++;
    });
    off();
    bus.publish('error', { message: 'boom', retriable: true });
    expect(errors).toBe(0);
  });

  it('isolates a throwing subscriber — sibling still delivered, publish never throws (C17)', () => {
    // A throwing callback used to escape the drain loop: it propagated out of publish() to the
    // caller AND starved every sibling queued after it in `ready`. Each callback is now isolated.
    const warnings: string[] = [];
    const diagnostics = {
      warn: (msg: string) => {
        warnings.push(msg);
      },
      debug() {},
    };
    const bus = createAppBus({ diagnostics });
    const sibling: unknown[] = [];
    bus.subscribe('state-delta', () => {
      throw new Error('boom');
    });
    bus.subscribe('state-delta', (p) => sibling.push(p.delta));
    expect(() => bus.publish('state-delta', { delta: [1] })).not.toThrow();
    expect(sibling).toEqual([[1]]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('does not deliver an in-flight batch to a subscriber unsubscribed mid-publish (bus-04)', () => {
    // `unsubscribe()` removed the sub from the topic Set, but the drain delivered from a `ready`
    // entry holding a direct ref, so a sub unsubscribed by a sibling mid-publish still got the batch.
    const bus = createAppBus();
    const bSeen: unknown[] = [];
    // Forward ref: A (subscribed first, so drained first) unsubscribes B before B is reached.
    const b: { off?: () => void } = {};
    bus.subscribe('state-delta', () => {
      b.off?.();
    });
    b.off = bus.subscribe('state-delta', (p) => bSeen.push(p.delta));
    bus.publish('state-delta', { delta: [1] });
    expect(bSeen).toEqual([]);
  });

  it('rejects an invalid capacity at construction — no publish hang (C02)', () => {
    // A negative capacity would spin the BoundedQueue push loop forever the moment a payload is
    // published; NaN would silently disable the bound. Fail closed at the public boundary instead.
    expect(() => createAppBus({ capacity: -1 })).toThrow(RangeError);
    expect(() => createAppBus({ capacity: Number.NaN })).toThrow(RangeError);
    expect(() => createAppBus({ capacity: 0 })).toThrow(RangeError);
  });

  it('a re-entrant publisher buffers (no stack recursion, no deadlock) and drops past capacity', () => {
    // The no-deadlock moat under load: a subscriber that re-publishes to its OWN topic
    // while mid-flight must NOT recurse the stack — the payload buffers in its bounded
    // queue and the in-flight drain loop picks it up. With a tiny capacity, an over-eager
    // re-publisher drops oldest and bumps droppedCount instead of overflowing.
    const bus = createAppBus({ capacity: 2 });
    const seen: Array<number | undefined> = [];
    let fanout = 0;
    bus.subscribe('state-delta', (p) => {
      seen.push((p.delta as number[])[0]);
      // re-publish a burst back to the same topic the first time only
      if (fanout === 0) {
        fanout = 1;
        for (let i = 1; i <= 5; i++) bus.publish('state-delta', { delta: [i] });
      }
    });
    bus.publish('state-delta', { delta: [0] });
    // first delivery (0) processed; its 5 re-published items hit a capacity-2 queue,
    // so the 3 oldest drop and only the last 2 are delivered — proving the bounded buffer engaged.
    expect(seen[0]).toBe(0);
    expect(bus.droppedCount).toBe(3);
    expect(seen.length).toBe(3); // [0] + last 2 survivors
  });

  it('surfaces bounded-queue drops through an injected DiagnosticsPort (§Z5/§Z30)', () => {
    // A REAL capturing DiagnosticsPort (records into an owned array) — the drop counter is the §Z5
    // swallow-site the composition root wires; it is no longer poll-only.
    const warnings: Array<[string, Record<string, unknown> | undefined]> = [];
    const diagnostics = {
      warn: (msg: string, meta?: Record<string, unknown>) => {
        warnings.push([msg, meta]);
      },
      debug() {},
    };
    const bus = createAppBus({ capacity: 2, diagnostics });
    let fanout = 0;
    bus.subscribe('state-delta', () => {
      if (fanout === 0) {
        fanout = 1;
        for (let i = 1; i <= 5; i++) bus.publish('state-delta', { delta: [i] });
      }
    });
    bus.publish('state-delta', { delta: [0] });
    expect(bus.droppedCount).toBe(3);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]?.[0]).toContain('dropped');
    expect(warnings.at(-1)?.[1]).toMatchObject({ topic: 'state-delta' });
  });

  it('bounds the ready scheduler under a re-entrant burst — no quadratic blowup (C02)', () => {
    // Pre-fix `ready.push(sub)` fires once per publish with no dedup, so a burst of N re-entrant
    // publishes leaves N entries drained via O(k) Array.shift() each — O(N^2), seconds+ for large N.
    // Post-fix a per-subscriber `scheduled` flag keeps `ready` to one entry per subscriber, O(N).
    const bus = createAppBus({ capacity: 4 });
    const N = 80_000;
    let bursted = false;
    let delivered = 0;
    bus.subscribe('state-delta', () => {
      delivered += 1;
      if (!bursted) {
        bursted = true;
        for (let i = 0; i < N; i++) bus.publish('state-delta', { delta: [i] });
      }
    });
    const start = process.hrtime.bigint();
    bus.publish('state-delta', { delta: [-1] });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    expect(delivered).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(1500);
  });

  it('preserves global publish order across subscribers under a re-entrant publish', () => {
    // Two subscribers on one topic; the first re-publishes from inside its callback. A single
    // global-FIFO drain makes BOTH observe [0, 1]; a per-subscriber drain would let the second
    // subscriber see the re-published 1 before the outer 0 (order-dependent RFC-6902 patches).
    const bus = createAppBus();
    const a: Array<number | undefined> = [];
    const b: Array<number | undefined> = [];
    let republished = false;
    bus.subscribe('state-delta', (p) => {
      a.push((p.delta as number[])[0]);
      if (!republished) {
        republished = true;
        bus.publish('state-delta', { delta: [1] });
      }
    });
    bus.subscribe('state-delta', (p) => {
      b.push((p.delta as number[])[0]);
    });
    bus.publish('state-delta', { delta: [0] });
    expect(a).toEqual([0, 1]);
    expect(b).toEqual([0, 1]);
  });
});
