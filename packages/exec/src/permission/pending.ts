import type { PermissionRequest, PermissionReply } from '@minitui/types';

// The channel surfaces the raw reply verdict; the engine (Task 13) turns 'always' into a grant
// from its own parsed command. Resolution mirrors the canonical PermissionReply union minus 'id'.
export interface PendingResolution {
  readonly kind: 'once' | 'always' | 'reject';
  readonly cascade?: boolean;
  readonly feedback?: string;
}

export interface PendingChannel {
  readonly requests: AsyncIterable<PermissionRequest>;
  ask(req: PermissionRequest): Promise<PendingResolution>;
  reply(reply: PermissionReply): void;
  disposeAll(reason: string): void;
}

interface Waiter {
  resolve(r: PendingResolution): void;
}

export function createPendingChannel(): PendingChannel {
  // FIFO of in-flight waiters. The canonical reply carries no id, so a reply resolves the
  // OLDEST pending request (the UI shows one consent at a time — head-of-queue is unambiguous).
  const waiters: Waiter[] = [];
  // simple unbounded async-iterable queue for the UI subscriber
  const buffer: PermissionRequest[] = [];
  let notify: (() => void) | undefined;

  async function* iterate(): AsyncIterable<PermissionRequest> {
    for (;;) {
      if (buffer.length === 0) {
        await new Promise<void>((res) => {
          notify = res;
        });
      }
      while (buffer.length > 0) yield buffer.shift()!;
    }
  }

  return {
    requests: { [Symbol.asyncIterator]: () => iterate()[Symbol.asyncIterator]() },

    ask(req) {
      return new Promise<PendingResolution>((resolve) => {
        waiters.push({ resolve });
        buffer.push(req);
        notify?.();
        notify = undefined;
      });
    },

    reply(reply) {
      const w = waiters.shift(); // head of queue
      if (!w) return;
      if (reply.kind === 'reject') {
        w.resolve({ kind: 'reject', feedback: reply.feedback });
        return;
      }
      if (reply.kind === 'always') {
        w.resolve({ kind: 'always', cascade: reply.cascade });
        return;
      }
      w.resolve({ kind: 'once' });
    },

    disposeAll(reason) {
      for (const w of waiters) w.resolve({ kind: 'reject', feedback: reason });
      waiters.length = 0;
    },
  };
}
