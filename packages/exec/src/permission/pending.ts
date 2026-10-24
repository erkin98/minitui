import type { PermissionRequest, PermissionReply } from '@minitui/types';

// The channel surfaces the raw reply verdict; the engine turns 'always' into a grant
// from its own parsed command. Resolution mirrors the canonical PermissionReply union minus the
// request id, which the channel has already used to find the waiter.
export interface PendingResolution {
  readonly kind: 'once' | 'always' | 'reject';
  readonly cascade?: boolean;
  readonly feedback?: string;
}

// The reason for a reply whose kind is none of the three. It is fixed: it never holds what was received.
export const UNRECOGNISED_REPLY_REASON = 'reply not recognised: treated as a rejection';

// The reason for a request whose id is already waiting for approval. It is fixed: it never holds any
// part of the request.
export const DUPLICATE_REQUEST_REASON = 'a request with this id is already waiting for approval';

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
  // In-flight waiters by the id of the request each one answers. A reply resolves exactly the waiter it
  // names; a reply that names none resolves nothing.
  const waiters = new Map<string, Waiter>();
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
        // A second request under an id that is already waiting is refused at once, before it reaches the
        // buffer the interface reads: the interface is never handed two requests under one id.
        if (waiters.has(req.id)) {
          resolve({ kind: 'reject', feedback: DUPLICATE_REQUEST_REASON });
          return;
        }
        waiters.set(req.id, { resolve });
        buffer.push(req);
        notify?.();
        notify = undefined;
      });
    },

    reply(reply) {
      const w = waiters.get(reply.requestId);
      if (!w) return;
      waiters.delete(reply.requestId);
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
      for (const w of waiters.values()) w.resolve({ kind: 'reject', feedback: reason });
      waiters.clear();
      // drop queued-but-unshown requests too, so a later re-subscribe can't replay a disposed consent
      buffer.length = 0;
    },
  };
}
