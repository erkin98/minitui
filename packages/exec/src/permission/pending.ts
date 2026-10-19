import type { PermissionRequest, PermissionReply } from '@minitui/types';

// The channel surfaces the raw reply verdict; the engine turns 'always' into a grant
// from its own parsed command. Resolution mirrors the canonical PermissionReply union minus 'id'.
export interface PendingResolution {
  readonly kind: 'once' | 'always' | 'reject';
  readonly cascade?: boolean;
  readonly feedback?: string;
}

// The reason for a reply whose kind is none of the three. It is fixed: it never holds what was received.
export const UNRECOGNISED_REPLY_REASON = 'reply not recognised: treated as a rejection';

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
      if (reply.kind === 'once') {
        w.resolve({ kind: 'once' });
        return;
      }
      // any other kind (a value from outside the typed seam) is a rejection, never an approval
      w.resolve({ kind: 'reject', feedback: UNRECOGNISED_REPLY_REASON });
    },

    disposeAll(reason) {
      for (const w of waiters) w.resolve({ kind: 'reject', feedback: reason });
      waiters.length = 0;
      // drop queued-but-unshown requests too, so a later re-subscribe can't replay a disposed consent
      buffer.length = 0;
    },
  };
}
