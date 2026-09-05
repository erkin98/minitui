import { describe, it, expect } from 'vitest';
import { createPendingChannel } from '../../src/permission/pending.js';
import type { PermissionRequest } from '@minitui/types';

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
});
