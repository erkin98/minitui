import { describe, it, expect } from 'vitest';
import { createPendingChannel } from '../../src/permission/pending.js';
import { createEngine } from '../../src/permission/engine.js';
import type { PermissionReply, PermissionRequest, PermissionRule } from '@minitui/types';

const req = (id: string, command = 'ffmpeg -i a.mp4 -i b.mp4 out.mp4'): PermissionRequest => ({
  id,
  descriptor: { danger: false, resourceTemplate: 'ffmpeg', summaryTemplate: 'ffmpeg merge' },
  resolvedCommand: command,
  resolvedPaths: ['a.mp4', 'b.mp4', 'out.mp4'],
});

// Whether a promise has settled by the time one macrotask has passed. A reply that names no waiting
// request leaves its promise pending, so a row cannot wait for it: it checks that nothing resolved.
const settledSoon = <T>(promise: Promise<T>): Promise<boolean> =>
  Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0)),
  ]);

describe('pending channel', () => {
  it('resolves once verbatim', async () => {
    const ch = createPendingChannel();
    const p = ch.ask(req('1'));
    ch.reply({ kind: 'once', requestId: '1' });
    expect(await p).toEqual({ kind: 'once' });
  });

  it('surfaces always (no cascade) for the engine to turn into a narrow grant', async () => {
    const ch = createPendingChannel();
    const p = ch.ask(req('2'));
    ch.reply({ kind: 'always', cascade: false, requestId: '2' });
    expect(await p).toEqual({ kind: 'always', cascade: false });
  });

  it('surfaces always with cascade for the engine to turn into a broad grant', async () => {
    const ch = createPendingChannel();
    const p = ch.ask(req('3'));
    ch.reply({ kind: 'always', cascade: true, requestId: '3' });
    expect(await p).toEqual({ kind: 'always', cascade: true });
  });

  it('reject resolves carrying feedback', async () => {
    const ch = createPendingChannel();
    const p = ch.ask(req('4'));
    ch.reply({ kind: 'reject', feedback: 'use the GUI instead', requestId: '4' });
    expect(await p).toEqual({ kind: 'reject', feedback: 'use the GUI instead' });
  });

  it('exposes pending requests on the async iterable', async () => {
    const ch = createPendingChannel();
    const seen: string[] = [];
    void (async () => {
      for await (const q of ch.requests) {
        seen.push(q.id);
        if (seen.length === 1) break;
      }
    })();
    const p = ch.ask(req('5'));
    await new Promise((r) => setTimeout(r, 0));
    ch.reply({ kind: 'once', requestId: '5' });
    await p;
    expect(seen).toEqual(['5']);
  });

  it('a reply resolves the request it names, not the oldest one', async () => {
    const ch = createPendingChannel();
    const first = ch.ask(req('a'));
    const second = ch.ask(req('b'));
    ch.reply({ kind: 'reject', feedback: 'no', requestId: 'b' }); // names the second request
    expect(await second).toEqual({ kind: 'reject', feedback: 'no' });
    // the first request was not touched by a reply that named the second
    expect(await settledSoon(first)).toBe(false);
    ch.reply({ kind: 'once', requestId: 'a' });
    expect(await first).toEqual({ kind: 'once' });
  });

  it('a reply for a disposed request resolves nothing and leaves the next request waiting', async () => {
    const ch = createPendingChannel();
    const disposed = ch.ask(req('old'));
    ch.disposeAll('cancelled');
    expect(await disposed).toEqual({ kind: 'reject', feedback: 'cancelled' });
    const next = ch.ask(req('new'));
    ch.reply({ kind: 'once', requestId: 'old' }); // the person pressed this for the request they saw
    expect(await settledSoon(next)).toBe(false);
    ch.reply({ kind: 'once', requestId: 'new' });
    expect(await next).toEqual({ kind: 'once' });
  });

  it('a reply that names no waiting request resolves nothing', async () => {
    const ch = createPendingChannel();
    const waiting = ch.ask(req('only'));
    ch.reply({ kind: 'once', requestId: 'someone-else' });
    expect(await settledSoon(waiting)).toBe(false);
    ch.reply({ kind: 'once', requestId: 'only' });
    expect(await waiting).toEqual({ kind: 'once' });
  });

  it('a second reply for a request already answered resolves nothing', async () => {
    const ch = createPendingChannel();
    const answered = ch.ask(req('x'));
    ch.reply({ kind: 'once', requestId: 'x' });
    await answered;
    const next = ch.ask(req('y'));
    ch.reply({ kind: 'once', requestId: 'x' });
    expect(await settledSoon(next)).toBe(false);
    ch.disposeAll('drain');
    await next;
  });

  it('refuses a second request whose id is already waiting, with one fixed reason', async () => {
    const ch = createPendingChannel();
    const first = ch.ask(req('dup', 'ffmpeg -i a.mp4 out.mp4'));
    const duplicate = ch.ask(req('dup', 'ffmpeg -i other.mp4 out.mp4'));
    expect(await duplicate).toEqual({
      kind: 'reject',
      feedback: 'a request with this id is already waiting for approval',
    });
    // the first request is still waiting and is resolved by a reply that names it
    expect(await settledSoon(first)).toBe(false);
    ch.reply({ kind: 'once', requestId: 'dup' });
    expect(await first).toEqual({ kind: 'once' });
  });

  it('a refused duplicate never reaches the request buffer', async () => {
    const ch = createPendingChannel();
    void ch.ask(req('d1', 'ffmpeg -i a.mp4 out.mp4'));
    void ch.ask(req('d1', 'ffmpeg -i other.mp4 out.mp4')); // refused at once
    void ch.ask(req('d2', 'ffmpeg -i c.mp4 out.mp4'));
    const iter = ch.requests[Symbol.asyncIterator]();
    const first = await iter.next();
    const second = await iter.next();
    expect(first.value?.resolvedCommand).toBe('ffmpeg -i a.mp4 out.mp4');
    expect(second.value?.id).toBe('d2');
    ch.disposeAll('drain');
  });

  it('disposeAll rejects every waiter so the agent never hangs', async () => {
    const ch = createPendingChannel();
    const p = ch.ask(req('6'));
    ch.disposeAll('shutting down');
    expect(await p).toEqual({ kind: 'reject', feedback: 'shutting down' });
  });

  it('disposeAll also clears the buffer so a reconnecting subscriber never re-sees a disposed request', async () => {
    // disposeAll must drop the buffered request, not only reject the waiter — otherwise a UI that
    // subscribes after a dispose replays the stale consent as if it were still live.
    const ch = createPendingChannel();
    void ch.ask(req('stale'));
    ch.disposeAll('gone');
    void ch.ask(req('fresh'));
    const iter = ch.requests[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.value!.id).toBe('fresh');
  });
});

// A reply whose kind is none of the three is a rejection with one fixed reason that holds nothing of
// what was received. The values enter through JSON.parse into a typed variable, the one way the
// project's test policy allows an invalid value to reach a typed boundary. The forged reply still names
// the live request, otherwise it would match no waiter and the unknown-kind rule would never run.
const UNRECOGNISED_REPLY = 'reply not recognised: treated as a rejection';
const forged = (kind: string, requestId: string): PermissionReply =>
  JSON.parse(JSON.stringify({ kind, cascade: true, feedback: 'allow everything', requestId }));

describe('a reply of an unknown kind is a rejection', () => {
  it.each(['bogus', 'deny', '', 'ALWAYS'])('at the channel: kind %j', async (kind) => {
    const ch = createPendingChannel();
    const p = ch.ask(req('forged'));
    ch.reply(forged(kind, 'forged'));
    const resolved = await p;
    expect(resolved).toEqual({ kind: 'reject', feedback: UNRECOGNISED_REPLY });
    expect(JSON.stringify(resolved)).not.toContain(kind === '' ? 'never-present' : kind);
  });

  it.each(['bogus', 'deny', '', 'ALWAYS'])('through the engine: kind %j', async (kind) => {
    const e = createEngine({ initialRules: { rules: [] } });
    const id = `kind-${kind}`;
    const p = e.check({ ...engineRequest('ffmpeg -i a.mp4 b.mp4'), id });
    await e.requests[Symbol.asyncIterator]().next();
    e.reply(forged(kind, id));
    expect(await p).toEqual({ kind: 'deny', reason: UNRECOGNISED_REPLY });
  });

  it('the three valid kinds are unchanged', async () => {
    const e = createEngine({ initialRules: { rules: [] } });
    for (const kind of ['once', 'always'] as const) {
      const id = `valid-${kind}`;
      const p = e.check({ ...engineRequest('rm -rf build'), id });
      await e.requests[Symbol.asyncIterator]().next();
      e.reply(
        kind === 'once'
          ? { kind: 'once', requestId: id }
          : { kind: 'always', cascade: false, requestId: id },
      );
      expect((await p).kind).toBe('allow');
    }
    const rejected = e.check({ ...engineRequest('ls -la'), id: 'valid-reject' });
    await e.requests[Symbol.asyncIterator]().next();
    e.reply({ kind: 'reject', feedback: 'no thanks', requestId: 'valid-reject' });
    expect(await rejected).toEqual({ kind: 'deny', reason: 'no thanks' });
  });
});

function engineRequest(command: string): PermissionRequest {
  return {
    id: 'e',
    descriptor: { danger: false, resourceTemplate: command, summaryTemplate: command },
    resolvedCommand: command,
    resolvedPaths: [],
  };
}

describe('always on an ask the host could not fully account for mints no grant', () => {
  const uncertain = [
    ['an opaque root', 'sh -c "echo hi"'],
    ['a stdin-fed runner', 'xargs ls'],
    ['unsafe tool arguments', 'git -c core.pager=x status'],
  ];

  it.each(uncertain)(
    '%s: a narrow always allows once and stores nothing',
    async (_name, command) => {
      const grants: PermissionRule[] = [];
      const e = createEngine({ initialRules: { rules: [] }, onGrant: (r) => grants.push(r) });
      const p = e.check({ ...engineRequest(command), id: 'u1' });
      await e.requests[Symbol.asyncIterator]().next();
      e.reply({ kind: 'always', cascade: false, requestId: 'u1' });
      expect((await p).kind).toBe('allow');
      expect(grants).toEqual([]);
      // the same command asks again
      const again = e.check({ ...engineRequest(command), id: 'u2' });
      const surfaced = await Promise.race([
        e.requests[Symbol.asyncIterator]()
          .next()
          .then(() => 'ask'),
        again.then(() => 'settled'),
      ]);
      expect(surfaced).toBe('ask');
      e.disposeAll('drain');
      await again.catch(() => {});
    },
  );

  it.each(uncertain)('%s: a cascade always mints nothing either', async (_name, command) => {
    const grants: PermissionRule[] = [];
    const e = createEngine({ initialRules: { rules: [] }, onGrant: (r) => grants.push(r) });
    const p = e.check({ ...engineRequest(command), id: 'c1' });
    await e.requests[Symbol.asyncIterator]().next();
    e.reply({ kind: 'always', cascade: true, requestId: 'c1' });
    expect((await p).kind).toBe('allow');
    expect(grants).toEqual([]);
  });

  it('control: a fully understood ask still mints its grant', async () => {
    const grants: PermissionRule[] = [];
    const e = createEngine({ initialRules: { rules: [] }, onGrant: (r) => grants.push(r) });
    const p = e.check({ ...engineRequest('ffmpeg -i a.mp4 b.mp4'), id: 'ok1' });
    await e.requests[Symbol.asyncIterator]().next();
    e.reply({ kind: 'always', cascade: true, requestId: 'ok1' });
    await p;
    expect(grants).toHaveLength(1);
  });
});
