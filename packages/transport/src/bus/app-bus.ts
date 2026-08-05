import { assertNever, type DiagnosticsPort } from '@minitui/types';
import { formatUnknown } from '../format-unknown.js';
import { BoundedQueue, assertValidCapacity } from './backpressure.js';
import type { BusPort, PublishArgs } from './bus-port.js';
import { COALESCIBLE, type Topic, type TopicPayloads, POSITIONAL } from './topics.js';

export interface AppBus extends BusPort {
  readonly droppedCount: number;
  /**
   * True once any subscriber's non-lossy queue has hit its growth ceiling and refused a payload,
   * so a positional stream is truncated at the tail. Monotone for the life of the bus and it
   * does NOT identify which subscription gapped: the per-subscription resettable signal, and the
   * resync it should trigger (clear local state, request a `state-snapshot`), belong to the first
   * real positional consumer — plan 10 runtime-host, Slice 2 (§Z138-A). Until that consumer
   * exists, transport reports the gap; it does not force a resync.
   */
  readonly gapped: boolean;
}

type DeliveryAttempt =
  | { readonly kind: 'empty' }
  | { readonly kind: 'threw'; readonly error: unknown }
  | { readonly kind: 'delivered'; readonly result: unknown };

interface ScheduledSub {
  readonly topic: Topic;
  scheduled: boolean;
  inFlight: boolean;
  live: boolean;
  dropping: boolean;
  gapReported: boolean;
  hasQueued(): boolean;
  deliverOne(): DeliveryAttempt;
  clear(): void;
}

interface TopicSub<T extends Topic> extends ScheduledSub {
  readonly queue: BoundedQueue<TopicPayloads[T]>;
}

interface TopicChannel<T extends Topic> {
  publish(payload: TopicPayloads[T]): void;
  subscribe(fn: (payload: TopicPayloads[T]) => void): () => void;
}

type ChannelMap = { [T in Topic]: TopicChannel<T> };

const MAX_SYNCHRONOUS_DELIVERIES = 1024;

export function createAppBus(opts?: { capacity?: number; diagnostics?: DiagnosticsPort }): AppBus {
  const capacity = opts?.capacity ?? 256;
  assertValidCapacity(capacity);
  const diagnostics = opts?.diagnostics;
  const ready: ScheduledSub[] = [];
  let readyHead = 0;
  let draining = false;
  let continuationScheduled = false;
  let dropped = 0;
  let gapped = false;

  const report = (message: string, meta: Record<string, unknown>): void => {
    try {
      const result = diagnostics?.warn(message, meta);
      if (result !== undefined) void Promise.resolve(result).catch(() => undefined);
    } catch {
      // Diagnostics is observational and cannot break bus delivery.
    }
  };

  const schedule = (sub: ScheduledSub): void => {
    if (!sub.live || sub.inFlight || sub.scheduled || !sub.hasQueued()) return;
    sub.scheduled = true;
    ready.push(sub);
  };

  const compactReady = (): void => {
    const remaining = ready.length - readyHead;
    if (remaining > 0) ready.copyWithin(0, readyHead);
    ready.length = remaining;
    readyHead = 0;
  };

  const scheduleContinuation = (): void => {
    if (continuationScheduled) return;
    continuationScheduled = true;
    setImmediate(() => {
      continuationScheduled = false;
      drainReady();
    });
  };

  const asPromise = (result: unknown): Promise<void> | undefined => {
    if (result === undefined || result === null) return undefined;
    if (typeof result !== 'object' && typeof result !== 'function') return undefined;
    try {
      const then: unknown = Reflect.get(result, 'then');
      if (typeof then !== 'function') return undefined;
      return new Promise<unknown>((resolve, reject) => {
        Reflect.apply(then, result, [resolve, reject]);
      }).then(() => undefined);
    } catch (error) {
      return Promise.reject(new Error(formatUnknown(error, 'promise assimilation failed')));
    }
  };

  const settleAsync = (sub: ScheduledSub, result: Promise<void>): void => {
    sub.inFlight = true;
    const resume = (): void => {
      sub.inFlight = false;
      schedule(sub);
      if (sub.scheduled) scheduleContinuation();
    };
    void Promise.resolve(result).then(resume, (error: unknown) => {
      report('app-bus subscriber rejected (isolated)', {
        topic: sub.topic,
        error: formatUnknown(error),
      });
      resume();
    });
  };

  function drainReady(): void {
    if (draining || continuationScheduled) return;
    draining = true;
    let deliveries = 0;
    try {
      while (readyHead < ready.length && deliveries < MAX_SYNCHRONOUS_DELIVERIES) {
        const sub = ready[readyHead++]!;
        sub.scheduled = false;
        if (!sub.live || sub.inFlight) continue;

        const attempt = sub.deliverOne();
        if (attempt.kind === 'empty') continue;
        deliveries += 1;
        if (attempt.kind === 'threw') {
          report('app-bus subscriber threw (isolated)', {
            topic: sub.topic,
            error: formatUnknown(attempt.error),
          });
          schedule(sub);
          continue;
        }
        const promise = asPromise(attempt.result);
        if (promise === undefined) schedule(sub);
        else settleAsync(sub, promise);
      }
    } finally {
      const hasReady = readyHead < ready.length;
      compactReady();
      draining = false;
      if (hasReady) scheduleContinuation();
    }
  }

  const createChannel = <T extends Topic>(topic: T): TopicChannel<T> => {
    const subscribers = new Set<TopicSub<T>>();
    return {
      publish(payload) {
        for (const sub of subscribers) {
          // Re-arm on catch-up: the report is edge-triggered on the transition INTO dropping and
          // fires again only once this subscriber has drained. `droppedCount` stays exact and
          // per-payload; what is bounded is the sink traffic, which an untrusted burst would
          // otherwise multiply one-for-one out of a single bounded queue.
          if (sub.queue.size === 0) sub.dropping = false;
          const before = sub.queue.dropped;
          sub.queue.push(payload);
          const justDropped = sub.queue.dropped - before;
          if (justDropped > 0) {
            dropped += justDropped;
            if (!sub.dropping) {
              sub.dropping = true;
              report('app-bus dropped oldest payload (subscriber backpressure)', {
                topic,
                dropped,
              });
            }
          }
          // A positional queue refuses payloads rather than evicting, so a drop here means the
          // consumer's sequence is truncated — a different fact from a superseding topic losing
          // a stale payload, and it needs its own message. Latched per subscriber so one stalled
          // consumer cannot amplify a burst into unbounded sink calls.
          if (sub.queue.gapped && !sub.gapReported) {
            sub.gapReported = true;
            gapped = true;
            report('app-bus positional queue lost contiguity (resync required)', { topic });
          }
          schedule(sub);
        }
        drainReady();
      },
      subscribe(fn) {
        const queue = new BoundedQueue<TopicPayloads[T]>(
          capacity,
          COALESCIBLE.has(topic),
          !POSITIONAL.has(topic),
        );
        const sub: TopicSub<T> = {
          queue,
          topic,
          scheduled: false,
          inFlight: false,
          live: true,
          dropping: false,
          gapReported: false,
          hasQueued: () => queue.size > 0,
          deliverOne() {
            // Read the wrapper: 'empty' is then exact rather than payload-dependent.
            const entry = queue.dequeue();
            if (entry === undefined) return { kind: 'empty' };
            try {
              return { kind: 'delivered', result: fn(entry.value) };
            } catch (error) {
              return { kind: 'threw', error };
            }
          },
          clear: () => queue.clear(),
        };
        subscribers.add(sub);
        return () => {
          if (!sub.live) return;
          sub.live = false;
          sub.clear();
          subscribers.delete(sub);
        };
      },
    };
  };

  const channels: ChannelMap = {
    token: createChannel('token'),
    content: createChannel('content'),
    visibility: createChannel('visibility'),
    'state-delta': createChannel('state-delta'),
    'state-snapshot': createChannel('state-snapshot'),
    'run-status': createChannel('run-status'),
    error: createChannel('error'),
    action: createChannel('action'),
  };

  return {
    get droppedCount() {
      return dropped;
    },
    get gapped() {
      return gapped;
    },
    publish(...args: PublishArgs): void {
      switch (args[0]) {
        case 'token':
          channels.token.publish(args[1]);
          return;
        case 'content':
          channels.content.publish(args[1]);
          return;
        case 'visibility':
          channels.visibility.publish(args[1]);
          return;
        case 'state-delta':
          channels['state-delta'].publish(args[1]);
          return;
        case 'state-snapshot':
          channels['state-snapshot'].publish(args[1]);
          return;
        case 'run-status':
          channels['run-status'].publish(args[1]);
          return;
        case 'error':
          channels.error.publish(args[1]);
          return;
        case 'action':
          channels.action.publish(args[1]);
          return;
        default:
          assertNever(args[0], 'topic');
      }
    },
    subscribe<T extends Topic>(topic: T, fn: (payload: TopicPayloads[T]) => void): () => void {
      return channels[topic].subscribe(fn);
    },
  };
}
