import { describe, it, expect } from 'vitest';
import { createPendingChannel } from '../../src/permission/pending.js';
import { createEngine } from '../../src/permission/engine.js';
import type { PermissionReply, PermissionRequest, PermissionRule } from '@minitui/types';

const req = (id: string): PermissionRequest => ({
  id,
  descriptor: { danger: false, resourceTemplate: 'ffmpeg', summaryTemplate: 'ffmpeg merge' },
  resolvedCommand: 'ffmpeg -i a.mp4 -i b.mp4 out.mp4',
  resolvedPaths: ['a.mp4', 'b.mp4', 'out.mp4'],
});

describe('pending channel', () => {
  it('resolves once verbatim', async () => {
    const ch = createPendingChannel();
    const p = ch.ask(req('1'));
    ch.reply({ kind: 'once' });
    expect(await p).toEqual({ kind: 'once' });
  });

  it('surfaces always (no cascade) for the engine to turn into a narrow grant', async () => {
    const ch = createPendingChannel();
    const p = ch.ask(req('2'));
    ch.reply({ kind: 'always', cascade: false });
    expect(await p).toEqual({ kind: 'always', cascade: false });
  });

  it('surfaces always with cascade for the engine to turn into a broad grant', async () => {
    const ch = createPendingChannel();
    const p = ch.ask(req('3'));
    ch.reply({ kind: 'always', cascade: true });
    expect(await p).toEqual({ kind: 'always', cascade: true });
  });

  it('reject resolves carrying feedback', async () => {
    const ch = createPendingChannel();
    const p = ch.ask(req('4'));
    ch.reply({ kind: 'reject', feedback: 'use the GUI instead' });
    expect(await p).toEqual({ kind: 'reject', feedback: 'use the GUI instead' });
  });

  it('exposes pending requests on the async iterable', async () => {
    const ch = createPendingChannel();
    const seen: string[] = [];
    (async () => {
      for await (const q of ch.requests) {
        seen.push(q.id);
        if (seen.length === 1) break;
      }
    })();
    const p = ch.ask(req('5'));
    await new Promise((r) => setTimeout(r, 0));
    ch.reply({ kind: 'once' });
    await p;
    expect(seen).toEqual(['5']);
  });

  it('a reply targets the OLDEST in-flight request (FIFO head)', async () => {
    const ch = createPendingChannel();
    const first = ch.ask(req('a'));
    const second = ch.ask(req('b'));
    ch.reply({ kind: 'reject', feedback: 'no' }); // resolves the head (a)
    expect(await first).toEqual({ kind: 'reject', feedback: 'no' });
    ch.reply({ kind: 'once' }); // now resolves b
    expect(await second).toEqual({ kind: 'once' });
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
    ch.ask(req('stale'));
    ch.disposeAll('gone');
    ch.ask(req('fresh'));
    const iter = ch.requests[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.value!.id).toBe('fresh');
  });
});

// A reply whose kind is none of the three is a rejection with one fixed reason that holds nothing of
// what was received. The values enter through JSON.parse into a typed variable, the one way the
// project's test policy allows an invalid value to reach a typed boundary.
const UNRECOGNISED_REPLY = 'reply not recognised: treated as a rejection';
const forged = (kind: string): PermissionReply =>
  JSON.parse(JSON.stringify({ kind, cascade: true, feedback: 'allow everything' }));

describe('a reply of an unknown kind is a rejection', () => {
  it.each(['bogus', 'deny', '', 'ALWAYS'])('at the channel: kind %j', async (kind) => {
    const ch = createPendingChannel();
    const p = ch.ask(req('forged'));
    ch.reply(forged(kind));
    const resolved = await p;
    expect(resolved).toEqual({ kind: 'reject', feedback: UNRECOGNISED_REPLY });
    expect(JSON.stringify(resolved)).not.toContain(kind === '' ? 'never-present' : kind);
  });

  it.each(['bogus', 'deny', '', 'ALWAYS'])('through the engine: kind %j', async (kind) => {
    const e = createEngine({ initialRules: { rules: [] } });
    const p = e.check({ ...engineRequest('ffmpeg -i a.mp4 b.mp4'), id: `kind-${kind}` });
    await e.requests[Symbol.asyncIterator]().next();
    e.reply(forged(kind));
    expect(await p).toEqual({ kind: 'deny', reason: UNRECOGNISED_REPLY });
  });

  it('the three valid kinds are unchanged', async () => {
    const e = createEngine({ initialRules: { rules: [] } });
    for (const reply of [{ kind: 'once' }, { kind: 'always', cascade: false }] as const) {
      const p = e.check({ ...engineRequest('rm -rf build'), id: `valid-${reply.kind}` });
      await e.requests[Symbol.asyncIterator]().next();
      e.reply(reply);
      expect((await p).kind).toBe('allow');
    }
    const rejected = e.check({ ...engineRequest('ls -la'), id: 'valid-reject' });
    await e.requests[Symbol.asyncIterator]().next();
    e.reply({ kind: 'reject', feedback: 'no thanks' });
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
      e.reply({ kind: 'always', cascade: false });
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
    e.reply({ kind: 'always', cascade: true });
    expect((await p).kind).toBe('allow');
    expect(grants).toEqual([]);
  });

  it('control: a fully understood ask still mints its grant', async () => {
    const grants: PermissionRule[] = [];
    const e = createEngine({ initialRules: { rules: [] }, onGrant: (r) => grants.push(r) });
    const p = e.check({ ...engineRequest('ffmpeg -i a.mp4 b.mp4'), id: 'ok1' });
    await e.requests[Symbol.asyncIterator]().next();
    e.reply({ kind: 'always', cascade: true });
    await p;
    expect(grants).toHaveLength(1);
  });
});
