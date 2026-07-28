import type { DiagnosticsPort } from '@minitui/types';
import { formatUnknown } from '../format-unknown.js';
import { BoundedQueue, assertValidCapacity } from './backpressure.js';
import type { BusPort, PublishArgs } from './bus-port.js';
import { COALESCIBLE, type Topic, type TopicPayloads } from './topics.js';

export interface AppBus extends BusPort {
  readonly droppedCount: number;
}

interface ScheduledSub {
  readonly topic: Topic;
  scheduled: boolean;
  live: boolean;
  drain(): void;
}

interface TopicSub<T extends Topic> extends ScheduledSub {
  readonly fn: (payload: TopicPayloads[T]) => void;
  readonly queue: BoundedQueue<TopicPayloads[T]>;
}

interface TopicChannel<T extends Topic> {
  publish(payload: TopicPayloads[T]): void;
  subscribe(fn: (payload: TopicPayloads[T]) => void): () => void;
}

type ChannelMap = { [T in Topic]: TopicChannel<T> };

export function createAppBus(opts?: { capacity?: number; diagnostics?: DiagnosticsPort }): AppBus {
  const capacity = opts?.capacity ?? 256;
  assertValidCapacity(capacity);
  const diagnostics = opts?.diagnostics;
  const ready: ScheduledSub[] = [];
  let readyHead = 0;
  let draining = false;
  let dropped = 0;

  const report = (message: string, meta: Record<string, unknown>): void => {
    try {
      diagnostics?.warn(message, meta);
    } catch {
      // Diagnostics is observational and cannot break bus delivery.
    }
  };

  const drainReady = (): void => {
    if (draining) return;
    draining = true;
    try {
      while (readyHead < ready.length) {
        const sub = ready[readyHead++]!;
        sub.scheduled = false;
        sub.drain();
      }
    } finally {
      ready.length = 0;
      readyHead = 0;
      draining = false;
    }
  };

  const createChannel = <T extends Topic>(topic: T): TopicChannel<T> => {
    const subscribers = new Set<TopicSub<T>>();
    return {
      publish(payload) {
        for (const sub of subscribers) {
          const before = sub.queue.dropped;
          sub.queue.push(payload);
          const justDropped = sub.queue.dropped - before;
          if (justDropped > 0) {
            dropped += justDropped;
            report('app-bus dropped oldest payload (subscriber backpressure)', {
              topic,
              dropped,
            });
          }
          if (!sub.scheduled) {
            sub.scheduled = true;
            ready.push(sub);
          }
        }
        drainReady();
      },
      subscribe(fn) {
        const queue = new BoundedQueue<TopicPayloads[T]>(capacity, COALESCIBLE.has(topic));
        const sub: TopicSub<T> = {
          fn,
          queue,
          topic,
          scheduled: false,
          live: true,
          drain() {
            const batch = queue.drain();
            if (!sub.live) return;
            for (const item of batch) {
              if (!sub.live) break;
              try {
                fn(item);
              } catch (error) {
                report('app-bus subscriber threw (isolated)', {
                  topic,
                  error: formatUnknown(error),
                });
              }
            }
          },
        };
        subscribers.add(sub);
        return () => {
          sub.live = false;
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
      }
    },
    subscribe<T extends Topic>(topic: T, fn: (payload: TopicPayloads[T]) => void): () => void {
      return channels[topic].subscribe(fn);
    },
  };
}
