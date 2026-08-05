import { runInNewContext } from 'node:vm';
import { describe, it, expect } from 'vitest';
import { createAppBus, type AppBus } from '../src/bus/app-bus.js';
import type { PublishArgs } from '../src/bus/bus-port.js';

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function flushDeliveries(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await nextImmediate();
}

/**
 * Drives `state-delta` through the PUBLIC bus with a subscriber stalled on a real pending
 * Promise on its first delivery only. That Promise is assimilated by the production `asPromise`
 * seam, so the subscriber stays in flight and its own queue accumulates — the only shape that
 * exercises app-bus's queue-POLICY wiring (`!POSITIONAL.has(topic)`) rather than the
 * BoundedQueue primitive in isolation. No mock, no reflection.
 */
function stalledDeltaBus(publishes: number): {
  readonly bus: AppBus;
  readonly seen: Array<number | undefined>;
  readonly release: () => void;
} {
  const bus = createAppBus({ capacity: 2 }); // non-lossy ceiling = capacity * 64 = 128
  const seen: Array<number | undefined> = [];
  let resolveStall = (): void => {};
  let stalled = false;
  bus.subscribe('state-delta', (payload) => {
    seen.push((payload.delta as number[])[0]);
    if (stalled) return undefined;
    stalled = true;
    return new Promise<void>((resolve) => {
      resolveStall = resolve;
    });
  });
  for (let i = 0; i < publishes; i += 1) bus.publish('state-delta', { delta: [i] });
  return { bus, seen, release: () => resolveStall() };
}

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

  it('isolates a throwing subscriber while delivering to siblings', () => {
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

  it('does not deliver an in-flight batch to a subscriber unsubscribed mid-publish', () => {
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

  it('stops before the next item when a subscriber unsubscribes inside a drained batch', () => {
    const bus = createAppBus({ capacity: 8 });
    const seen: number[] = [];
    let off = (): void => {};
    off = bus.subscribe('state-delta', (payload) => {
      const value = (payload.delta as number[])[0];
      if (value === undefined) return;
      seen.push(value);
      if (value === 0) {
        bus.publish('state-delta', { delta: [1] });
        bus.publish('state-delta', { delta: [2] });
      } else if (value === 1) {
        off();
      }
    });
    bus.publish('state-delta', { delta: [0] });
    expect(seen).toEqual([0, 1]);
  });

  it('formats a hostile thrown value without escaping or starving siblings', () => {
    const warnings: string[] = [];
    const bus = createAppBus({
      diagnostics: {
        warn(message) {
          warnings.push(message);
        },
        debug() {},
      },
    });
    let siblingCalls = 0;
    bus.subscribe('content', () => {
      throw Object.create(null);
    });
    bus.subscribe('content', () => {
      siblingCalls++;
    });
    expect(() => bus.publish('content', 'x')).not.toThrow();
    expect(siblingCalls).toBe(1);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('rejects an invalid capacity at construction', () => {
    // A negative capacity would spin the BoundedQueue push loop forever the moment a payload is
    // published; NaN would silently disable the bound. Fail closed at the public boundary instead.
    expect(() => createAppBus({ capacity: -1 })).toThrow(RangeError);
    expect(() => createAppBus({ capacity: Number.NaN })).toThrow(RangeError);
    expect(() => createAppBus({ capacity: 0 })).toThrow(RangeError);
  });

  it('gives state-delta a non-lossy queue: a stalled subscriber loses no delta below the ceiling', async () => {
    // `app-bus.ts`'s `!POSITIONAL.has(topic)` is the line that gives state-delta its non-lossy
    // queue at all, and nothing exercised it behaviourally: replacing it with a literal `true`
    // restored the original overwrite-oldest defect and left the whole suite green.
    const { bus, seen, release } = stalledDeltaBus(100);
    expect(bus.droppedCount).toBe(0);
    expect(bus.gapped).toBe(false);

    release();
    await flushDeliveries();
    expect(seen).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it('latches a bus-visible gap once a state-delta subscriber passes the ceiling', async () => {
    // Past the ceiling the queue refuses INCOMING deltas, so the delivered prefix stays
    // contiguous from the first published one and the truncation lands at the tail. The latch
    // is what makes that visible: without a reader, `gapped` is a private flag nothing consults.
    const { bus, seen, release } = stalledDeltaBus(300);
    expect(bus.gapped).toBe(true);
    expect(bus.droppedCount).toBe(171); // 299 queued behind the stall - 128 admitted

    release();
    await flushDeliveries();
    // delta 0 delivered before the stall, then the 128 admitted: contiguous 0..128, no hole.
    expect(seen).toEqual(Array.from({ length: 129 }, (_, i) => i));
  });

  // The drop-behaviour tests below publish on a SUPERSEDING topic. state-delta carries
  // positional RFC-6902 operations and its queue never silently evicts, so it cannot be
  // used to exercise the bounded-queue drop path.
  it('a re-entrant publisher buffers (no stack recursion, no deadlock) and drops past capacity', () => {
    // The no-deadlock moat under load: a subscriber that re-publishes to its OWN topic
    // while mid-flight must NOT recurse the stack — the payload buffers in its bounded
    // queue and the in-flight drain loop picks it up. With a tiny capacity, an over-eager
    // re-publisher drops oldest and bumps droppedCount instead of overflowing.
    const bus = createAppBus({ capacity: 2 });
    const seen: Array<number | undefined> = [];
    let fanout = 0;
    bus.subscribe('state-snapshot', (p) => {
      seen.push((p.snapshot as number[])[0]);
      // re-publish a burst back to the same topic the first time only
      if (fanout === 0) {
        fanout = 1;
        for (let i = 1; i <= 5; i++) bus.publish('state-snapshot', { snapshot: [i] });
      }
    });
    bus.publish('state-snapshot', { snapshot: [0] });
    // first delivery (0) processed; its 5 re-published items hit a capacity-2 queue,
    // so the 3 oldest drop and only the last 2 are delivered — proving the bounded buffer engaged.
    expect(seen[0]).toBe(0);
    expect(bus.droppedCount).toBe(3);
    expect(seen.length).toBe(3); // [0] + last 2 survivors
  });

  it('surfaces bounded-queue drops through an injected DiagnosticsPort', () => {
    // A capturing DiagnosticsPort records the drop counter in an owned array.
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
    bus.subscribe('state-snapshot', () => {
      if (fanout === 0) {
        fanout = 1;
        for (let i = 1; i <= 5; i++) bus.publish('state-snapshot', { snapshot: [i] });
      }
    });
    bus.publish('state-snapshot', { snapshot: [0] });
    expect(bus.droppedCount).toBe(3);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]?.[0]).toContain('dropped');
    expect(warnings.at(-1)?.[1]).toMatchObject({ topic: 'state-snapshot' });
  });

  it('reports one diagnostic per stall episode, not one per dropped payload', () => {
    // The amplification is across publishes, not across the subscribers of one publish: an
    // untrusted producer controlling burst size controlled the number of sink calls one-for-one.
    // `droppedCount` stays exact and per-payload; only the report is edge-triggered.
    const warnings: Array<[string, Record<string, unknown> | undefined]> = [];
    const diagnostics = {
      warn: (msg: string, meta?: Record<string, unknown>) => {
        warnings.push([msg, meta]);
      },
      debug() {},
    };
    const bus = createAppBus({ capacity: 2, diagnostics });
    let bursted = false;
    bus.subscribe('state-snapshot', () => {
      if (bursted) return;
      bursted = true;
      for (let i = 0; i < 500; i += 1) bus.publish('state-snapshot', { snapshot: [i] });
    });
    bus.publish('state-snapshot', { snapshot: [-1] });

    expect(bus.droppedCount).toBe(498);
    expect(warnings).toHaveLength(1);
  });

  it('bounds the ready scheduler under a re-entrant burst', () => {
    // A per-subscriber `scheduled` flag keeps the ready list to one entry per subscriber.
    const bus = createAppBus({ capacity: 4 });
    const N = 80_000;
    let bursted = false;
    let delivered = 0;
    bus.subscribe('state-snapshot', () => {
      delivered += 1;
      if (!bursted) {
        bursted = true;
        for (let i = 0; i < N; i++) bus.publish('state-snapshot', { snapshot: [i] });
      }
    });
    bus.publish('state-snapshot', { snapshot: [-1] });
    expect(delivered).toBeGreaterThan(0);
    expect(bus.droppedCount).toBe(N - 4);
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

  it('preserves global order across topics when one ready queue already has two items', () => {
    const bus = createAppBus();
    const seen: number[] = [];
    bus.subscribe('state-delta', (payload) => {
      const value = (payload.delta as number[])[0];
      if (value !== undefined) seen.push(value);
    });
    bus.subscribe('run-status', () => seen.push(2));
    bus.subscribe('action', () => {
      bus.publish('state-delta', { delta: [1] });
      bus.publish('run-status', { phase: 'started' });
      bus.publish('state-delta', { delta: [3] });
    });

    bus.publish('action', { toolCallId: 'start' });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('contains an asynchronous subscriber rejection and reports it', async () => {
    const warnings: string[] = [];
    const rejected = Promise.reject(new Error('async subscriber boom'));
    await rejected.catch(() => undefined);
    const bus = createAppBus({
      diagnostics: {
        warn(message) {
          warnings.push(message);
        },
        debug() {},
      },
    });
    bus.subscribe('content', () => rejected);

    bus.publish('content', 'x');
    await nextImmediate();
    expect(warnings).toContain('app-bus subscriber rejected (isolated)');
  });

  it('keeps a cross-realm Promise callback in flight', () => {
    const foreignPending: unknown = runInNewContext('new Promise(() => {})');
    const bus = createAppBus();
    let calls = 0;
    const off = bus.subscribe('content', () => {
      calls += 1;
      return foreignPending;
    });

    bus.publish('content', 'first');
    bus.publish('content', 'second');
    expect(calls).toBe(1);
    off();
  });

  it('contains a cross-realm Promise rejection and reports it', async () => {
    const foreignRejected: unknown = runInNewContext(
      "(() => { const value = Promise.reject(new Error('foreign boom')); value.catch(() => {}); return value; })()",
    );
    const warnings: string[] = [];
    const bus = createAppBus({
      diagnostics: {
        warn(message) {
          warnings.push(message);
        },
        debug() {},
      },
    });
    bus.subscribe('content', () => foreignRejected);

    bus.publish('content', 'x');
    await nextImmediate();
    expect(warnings).toContain('app-bus subscriber rejected (isolated)');
  });

  it('reads a custom thenable once per delivery and keeps its subscriber in flight', async () => {
    let callbackCalls = 0;
    let getterReads = 0;
    let thenCalls = 0;
    let release = (): void => {};
    const pendingThenable = Object.defineProperty({}, 'then', {
      get() {
        getterReads += 1;
        return (resolve: () => void): void => {
          thenCalls += 1;
          release = resolve;
        };
      },
    });
    const bus = createAppBus();
    const off = bus.subscribe('content', () => {
      callbackCalls += 1;
      return pendingThenable;
    });

    bus.publish('content', 'first');
    bus.publish('content', 'second');

    expect({ callbackCalls, getterReads, thenCalls }).toEqual({
      callbackCalls: 1,
      getterReads: 1,
      thenCalls: 1,
    });

    release();
    await nextImmediate();
    await nextImmediate();
    expect({ callbackCalls, getterReads, thenCalls }).toEqual({
      callbackCalls: 2,
      getterReads: 2,
      thenCalls: 2,
    });
    off();
  });

  it('isolates a throwing then getter and continues sibling delivery', async () => {
    const warnings: string[] = [];
    let getterReads = 0;
    let siblingCalls = 0;
    const throwingThenable = Object.defineProperty({}, 'then', {
      get() {
        getterReads += 1;
        throw new Error('then getter boom');
      },
    });
    const bus = createAppBus({
      diagnostics: {
        warn(message) {
          warnings.push(message);
        },
        debug() {},
      },
    });
    bus.subscribe('content', () => throwingThenable);
    bus.subscribe('content', () => {
      siblingCalls += 1;
    });

    expect(() => bus.publish('content', 'x')).not.toThrow();
    await nextImmediate();

    expect(getterReads).toBe(1);
    expect(siblingCalls).toBe(1);
    expect(warnings).toContain('app-bus subscriber rejected (isolated)');
  });

  it('isolates a throwing then invocation and continues sibling delivery', async () => {
    const warnings: string[] = [];
    let thenCalls = 0;
    let siblingCalls = 0;
    const throwingThenable = {
      then(): void {
        thenCalls += 1;
        throw new Error('then invocation boom');
      },
    };
    const bus = createAppBus({
      diagnostics: {
        warn(message) {
          warnings.push(message);
        },
        debug() {},
      },
    });
    bus.subscribe('content', () => throwingThenable);
    bus.subscribe('content', () => {
      siblingCalls += 1;
    });

    expect(() => bus.publish('content', 'x')).not.toThrow();
    await nextImmediate();

    expect(thenCalls).toBe(1);
    expect(siblingCalls).toBe(1);
    expect(warnings).toContain('app-bus subscriber rejected (isolated)');
  });

  it('isolates a then-access throw whose value is a Proxy with a throwing getPrototypeOf trap', async () => {
    // A totality guard fronted by `instanceof` is itself throwable: `instanceof` invokes
    // getPrototypeOf, so testing the caught value's type before formatting it lets a hostile
    // Proxy escape the very containment the catch was written to provide.
    const warnings: string[] = [];
    const hostileProxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('getPrototypeOf trap boom');
        },
      },
    );
    const throwingThenable = Object.defineProperty({}, 'then', {
      get() {
        throw hostileProxy;
      },
    });
    const bus = createAppBus({
      diagnostics: {
        warn(message) {
          warnings.push(message);
        },
        debug() {},
      },
    });
    let siblingCalls = 0;
    bus.subscribe('content', () => throwingThenable);
    bus.subscribe('content', () => {
      siblingCalls += 1;
    });

    expect(() => bus.publish('content', 'x')).not.toThrow();
    await nextImmediate();

    expect(siblingCalls).toBe(1);
    expect(warnings).toContain('app-bus subscriber rejected (isolated)');
  });

  it('throws on a topic outside the modeled union instead of silently dropping it', () => {
    // No `default` meant a new Topic member could compile silently unwired; the exhaustiveness
    // assert turns that into a hard runtime failure on any value the switch doesn't model.
    const bus = createAppBus();
    const args: PublishArgs = JSON.parse('["bogus-topic", {}]');
    expect(() => bus.publish(...args)).toThrow();
  });

  it('keeps one async callback in flight and applies capacity to its pending queue', async () => {
    let release = (): void => {};
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bus = createAppBus({ capacity: 2 });
    const seen: number[] = [];
    let active = 0;
    let maxActive = 0;
    bus.subscribe('state-snapshot', async (payload) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await blocker;
      const value = (payload.snapshot as number[])[0];
      if (value !== undefined) seen.push(value);
      active -= 1;
    });

    for (let value = 0; value <= 5; value++) {
      bus.publish('state-snapshot', { snapshot: [value] });
    }
    expect(maxActive).toBe(1);
    expect(bus.droppedCount).toBe(3);

    release();
    for (let turn = 0; turn < 4; turn++) await nextImmediate();
    expect(seen).toEqual([0, 4, 5]);
  });

  it('yields a one-for-one re-publisher after a finite synchronous turn budget', async () => {
    const bus = createAppBus();
    const target = 3000;
    let delivered = 0;
    bus.subscribe('content', () => {
      delivered += 1;
      if (delivered < target) bus.publish('content', String(delivered));
    });

    bus.publish('content', 'start');
    expect(delivered).toBeLessThan(target);
    while (delivered < target) await nextImmediate();
    expect(delivered).toBe(target);
  });

  it('yields an immediately resolved async re-publisher before the next delivery', async () => {
    const bus = createAppBus();
    const target = 3000;
    let delivered = 0;
    let off = (): void => {};
    const firstImmediate = new Promise<number>((resolve) => {
      setImmediate(() => {
        const observed = delivered;
        off();
        resolve(observed);
      });
    });
    off = bus.subscribe('content', () => {
      delivered += 1;
      if (delivered < target) bus.publish('content', String(delivered));
      return Promise.resolve();
    });

    bus.publish('content', 'start');
    expect(await firstImmediate).toBe(1);
  });

  it('coalesces token, content, and visibility queues to their latest pending payload', async () => {
    const tokenBus = createAppBus();
    let releaseToken = (): void => {};
    const tokenBlocker = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    const tokens: string[] = [];
    tokenBus.subscribe('token', async (payload) => {
      tokens.push(payload);
      if (payload === 'seed') await tokenBlocker;
    });
    tokenBus.publish('token', 'seed');
    tokenBus.publish('token', 'a');
    tokenBus.publish('token', 'b');
    releaseToken();

    const contentBus = createAppBus();
    let releaseContent = (): void => {};
    const contentBlocker = new Promise<void>((resolve) => {
      releaseContent = resolve;
    });
    const content: string[] = [];
    contentBus.subscribe('content', async (payload) => {
      content.push(payload);
      if (payload === 'seed') await contentBlocker;
    });
    contentBus.publish('content', 'seed');
    contentBus.publish('content', 'a');
    contentBus.publish('content', 'b');
    releaseContent();

    const visibilityBus = createAppBus();
    let releaseVisibility = (): void => {};
    const visibilityBlocker = new Promise<void>((resolve) => {
      releaseVisibility = resolve;
    });
    const notes: string[] = [];
    visibilityBus.subscribe('visibility', async (payload) => {
      notes.push(payload.note);
      if (payload.note === 'seed') await visibilityBlocker;
    });
    visibilityBus.publish('visibility', { note: 'seed' });
    visibilityBus.publish('visibility', { note: 'a' });
    visibilityBus.publish('visibility', { note: 'b' });
    releaseVisibility();

    await nextImmediate();
    await nextImmediate();
    expect(tokens).toEqual(['seed', 'b']);
    expect(content).toEqual(['seed', 'b']);
    expect(notes).toEqual(['seed', 'b']);
  });
});
