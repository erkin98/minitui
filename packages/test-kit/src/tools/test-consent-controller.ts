import type { ConsentController } from '@minitui/renderer-ink';
import type { PermissionReply, PermissionRequest } from '@minitui/types';

/** Anything that surfaces requests and takes replies: the test engine or the real one. */
export interface ConsentSource {
  readonly requests: AsyncIterable<PermissionRequest>;
  reply(reply: PermissionReply): void;
}

/**
 * The test twin of the cli's consent controller (`apps/cli/src/consent.ts`), which no other package can
 * import. It shows one request at a time, the oldest first, and answers the request on screen by its id:
 * allow is once, always keeps its cascade flag, deny is a rejection with host-written feedback.
 */
export function createTestConsentController(engine: ConsentSource): ConsentController {
  let queue: readonly PermissionRequest[] = [];
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  void (async () => {
    for await (const request of engine.requests) {
      queue = [...queue, request];
      if (queue.length === 1) notify();
    }
  })();
  return {
    get request() {
      return queue[0];
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    resolve(decision) {
      const head = queue[0];
      if (head === undefined) return;
      queue = queue.slice(1);
      const requestId = head.id;
      switch (decision.kind) {
        case 'allow':
          engine.reply({ kind: 'once', requestId });
          break;
        case 'always':
          engine.reply({ kind: 'always', cascade: decision.cascade, requestId });
          break;
        case 'deny':
          engine.reply({ kind: 'reject', feedback: 'denied by user', requestId });
          break;
      }
      notify();
    },
  };
}
