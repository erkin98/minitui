import type { ConsentController } from '@minitui/renderer-ink';
import type { PermissionReply, PermissionRequest } from '@minitui/types';

/**
 * The slice of the permission engine this controller drives: the channel of pending requests and the sink
 * for the answer. The engine satisfies it; a test supplies a real in-memory one.
 */
export interface ConsentEngine {
  readonly requests: AsyncIterable<PermissionRequest>;
  reply(reply: PermissionReply): void;
}

/**
 * Connects the engine's pending requests to the consent overlay and maps the person's answer onto the
 * engine's reply. The overlay shows one request at a time, the oldest the engine surfaced, and every reply
 * carries that request's id, so a later request is never approved by an answer to an earlier one. The
 * feedback text of a rejection is written here; it is never text from the agent. Whether an always-grant
 * can reach a hard-floor action is decided in the engine, not here.
 */
export function makeConsentController(engine: ConsentEngine): ConsentController {
  const queue: PermissionRequest[] = [];
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  void (async () => {
    for await (const req of engine.requests) {
      queue.push(req);
      if (queue.length === 1) notify();
    }
  })();
  return {
    get request() {
      return queue[0];
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resolve(decision) {
      const head = queue.shift();
      if (head === undefined) return;
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
