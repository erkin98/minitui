import { describe, it, expect } from 'vitest';
import type { PermissionReply, PermissionRequest } from '@minitui/types';
import { makeConsentController, type ConsentEngine } from '../src/consent.js';

const request = (id: string): PermissionRequest => ({
  id,
  descriptor: { danger: false, resourceTemplate: 'ffmpeg', summaryTemplate: 'Merge the clips' },
  resolvedCommand: 'ffmpeg -i a.mp4 out.mp4',
  resolvedPaths: ['/work/a.mp4'],
});

// A real in-memory engine: the pending channel is an async iterable fed by `push`, and the replies it
// is given are recorded in order.
function fakeEngine(): {
  engine: ConsentEngine;
  push: (req: PermissionRequest) => void;
  replies: PermissionReply[];
} {
  const queue: PermissionRequest[] = [];
  const replies: PermissionReply[] = [];
  let wake: (() => void) | undefined;
  const engine: ConsentEngine = {
    requests: (async function* () {
      for (;;) {
        const next = queue.shift();
        if (next === undefined) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        yield next;
      }
    })(),
    reply: (reply) => {
      replies.push(reply);
    },
  };
  return {
    engine,
    replies,
    push: (req) => {
      queue.push(req);
      wake?.();
    },
  };
}

// Let the pump read what was pushed.
const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};

describe('makeConsentController', () => {
  it('is idle until the engine surfaces a request, then shows it', async () => {
    const { engine, push } = fakeEngine();
    const controller = makeConsentController(engine);
    expect(controller.request).toBeUndefined();
    push(request('r1'));
    await settle();
    expect(controller.request?.id).toBe('r1');
  });

  it('allow answers once, naming the request on screen', async () => {
    const { engine, push, replies } = fakeEngine();
    const controller = makeConsentController(engine);
    push(request('r1'));
    await settle();
    controller.resolve({ kind: 'allow' });
    expect(replies).toEqual([{ kind: 'once', requestId: 'r1' }]);
  });

  it.each([true, false])('always answers always with cascade %s', async (cascade) => {
    const { engine, push, replies } = fakeEngine();
    const controller = makeConsentController(engine);
    push(request('r1'));
    await settle();
    controller.resolve({ kind: 'always', cascade });
    expect(replies).toEqual([{ kind: 'always', cascade, requestId: 'r1' }]);
  });

  it('deny answers reject with a feedback line the host wrote', async () => {
    const { engine, push, replies } = fakeEngine();
    const controller = makeConsentController(engine);
    push(request('r1'));
    await settle();
    controller.resolve({ kind: 'deny' });
    expect(replies).toEqual([{ kind: 'reject', feedback: 'denied by user', requestId: 'r1' }]);
  });

  it('a second request never replaces the one on screen, and the reply names the first', async () => {
    const { engine, push, replies } = fakeEngine();
    const controller = makeConsentController(engine);
    push(request('first'));
    await settle();
    push(request('second'));
    await settle();
    expect(controller.request?.id).toBe('first');
    controller.resolve({ kind: 'allow' });
    expect(replies).toEqual([{ kind: 'once', requestId: 'first' }]);
    expect(controller.request?.id).toBe('second');
    controller.resolve({ kind: 'deny' });
    expect(replies[1]).toEqual({ kind: 'reject', feedback: 'denied by user', requestId: 'second' });
    expect(controller.request).toBeUndefined();
  });

  it('notifies on the first request and on each promotion, not on a request queued behind', async () => {
    const { engine, push } = fakeEngine();
    const controller = makeConsentController(engine);
    let notified = 0;
    controller.subscribe(() => {
      notified += 1;
    });
    push(request('a'));
    await settle();
    expect(notified).toBe(1);
    push(request('b'));
    await settle();
    expect(notified).toBe(1);
    controller.resolve({ kind: 'allow' });
    expect(notified).toBe(2);
  });

  it('a resolve with nothing pending replies nothing', () => {
    const { engine, replies } = fakeEngine();
    const controller = makeConsentController(engine);
    controller.resolve({ kind: 'allow' });
    expect(replies).toEqual([]);
  });

  it('an unsubscribed listener is not notified', async () => {
    const { engine, push } = fakeEngine();
    const controller = makeConsentController(engine);
    let notified = 0;
    const unsubscribe = controller.subscribe(() => {
      notified += 1;
    });
    unsubscribe();
    push(request('a'));
    await settle();
    expect(notified).toBe(0);
  });
});
