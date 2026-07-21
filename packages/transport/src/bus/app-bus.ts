import { type Topic, type TopicPayloads, COALESCIBLE } from './topics.js';
import { BoundedQueue } from './backpressure.js';
import type { BusPort } from './bus-port.js';
import type { DiagnosticsPort } from '@minitui/types';

export interface AppBus extends BusPort {
  readonly droppedCount: number;
}

interface Sub<T extends Topic> {
  fn: (p: TopicPayloads[T]) => void;
  queue: BoundedQueue<TopicPayloads[T]>;
}

export function createAppBus(opts?: { capacity?: number; diagnostics?: DiagnosticsPort }): AppBus {
  const capacity = opts?.capacity ?? 256;
  const diagnostics = opts?.diagnostics;
  const subs = new Map<Topic, Set<Sub<Topic>>>();
  let dropped = 0;
  // Single global-FIFO delivery: `ready` records subscribers with buffered payloads in GLOBAL
  // publish order (one entry per pushed payload); `draining` is the one drain-loop flag. A
  // re-entrant publish only appends to `ready` and returns — the outermost publish owns the
  // drain — so every subscriber observes payloads in publish order (a per-subscriber drain would
  // let a later subscriber see a re-published payload before the outer one, inverting order-
  // dependent RFC-6902 patches).
  const ready: Array<Sub<Topic>> = [];
  let draining = false;

  const setFor = (topic: Topic): Set<Sub<Topic>> => {
    let s = subs.get(topic);
    if (!s) {
      s = new Set();
      subs.set(topic, s);
    }
    return s;
  };

  return {
    get droppedCount() {
      return dropped;
    },
    publish<T extends Topic>(topic: T, payload: TopicPayloads[T]): void {
      const s = subs.get(topic);
      if (!s) return;
      for (const sub of s) {
        const before = sub.queue.dropped;
        // `as never`: existential-map variance boundary — `Map<Topic, Sub>` erases the per-key
        // payload relationship (TS has no existential types), so `TopicPayloads[T]` cannot be proven
        // assignable to this erased sub's queue element type. This is the standard typed-pub/sub escape,
        // NOT a fixable type-gap dodge (the §v10/§Z42 completion casts were removed above); leave as-is.
        sub.queue.push(payload as never);
        const justDropped = sub.queue.dropped - before;
        if (justDropped > 0) {
          dropped += justDropped;
          // §Z5/§Z30: the bounded-queue drop is a real backpressure signal, not swallowed — surface it
          // through the injected DiagnosticsPort (still poll-able via droppedCount) so a runaway
          // re-publisher on `topic` is observable at the composition root's log sink.
          diagnostics?.warn('app-bus dropped oldest payload (subscriber backpressure)', {
            topic,
            dropped,
          });
        }
        // Record this subscriber for delivery in cross-subscriber publish order. The per-subscriber
        // BoundedQueue still caps/coalesces the payload (drop-oldest into droppedCount); `ready`
        // only tracks WHEN each subscriber is due, so the single drain below delivers globally FIFO.
        ready.push(sub);
      }
      // The no-deadlock + in-order mechanism: whoever is not already draining runs the ONE loop.
      // A re-entrant publish appended to `ready` above and returned, so the outer loop picks it up
      // instead of recursing the stack; a runaway re-publisher drops oldest (bounded queue) rather
      // than overflowing the stack or blocking the producer.
      if (draining) return;
      draining = true;
      try {
        while (ready.length) {
          const sub = ready.shift();
          if (!sub) break;
          for (const item of sub.queue.drain()) (sub.fn as (p: unknown) => void)(item);
        }
      } finally {
        draining = false;
      }
    },
    subscribe<T extends Topic>(topic: T, fn: (p: TopicPayloads[T]) => void): () => void {
      const sub: Sub<T> = {
        fn,
        queue: new BoundedQueue<TopicPayloads[T]>(capacity, COALESCIBLE.has(topic)),
      };
      const set = setFor(topic);
      set.add(sub as unknown as Sub<Topic>);
      return () => set.delete(sub as unknown as Sub<Topic>);
    },
  };
}
