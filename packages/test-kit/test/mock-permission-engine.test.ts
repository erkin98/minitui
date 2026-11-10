import { describe, it, expect } from 'vitest';
import type { PermissionGatePort, PermissionReply, PermissionRequest } from '@minitui/types';
import {
  createMockPermissionEngine,
  UNRECOGNISED_REPLY,
} from '../src/tools/mock-permission-engine.js';

// The canonical host-resolved request. The double keys its policy off resolvedCommand; each request gets
// its own id, as the host mints them.
let made = 0;
const req = (resolvedCommand: string): PermissionRequest => {
  made += 1;
  return {
    id: `request-${made}`,
    descriptor: {
      danger: true,
      resourceTemplate: resolvedCommand,
      summaryTemplate: `run ${resolvedCommand}`,
    },
    resolvedCommand,
    resolvedPaths: [],
  };
};

// One turn of the event loop: long enough for a promise that is going to settle to settle.
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('MockPermissionEngine', () => {
  it('is a permission gate port', () => {
    const gate: PermissionGatePort = createMockPermissionEngine();
    expect(typeof gate.check).toBe('function');
  });

  it('returns allow and deny at once per policy keyed on resolvedCommand', async () => {
    const e = createMockPermissionEngine({ 'ffmpeg merge': 'allow', 'rm rf': 'deny' });
    expect((await e.check(req('ffmpeg merge'))).kind).toBe('allow');
    const d = await e.check(req('rm rf'));
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny') expect(d.reason).toMatch(/policy/i);
  });

  it('reads only its own policy keys: a command named like a prototype member gets the default', async () => {
    const e = createMockPermissionEngine({}, { defaultDecision: 'deny' });
    expect((await e.check(req('constructor'))).kind).toBe('deny');
    expect((await e.check(req('toString'))).kind).toBe('deny');
  });

  it('keeps an ask pending inside check until the reply that names it, after surfacing the request', async () => {
    const e = createMockPermissionEngine({ 'curl x': 'ask' });
    const channel = e.requests[Symbol.asyncIterator]();
    const r = req('curl x');
    let settled = false;
    const pending = e.check(r).then((d) => {
      settled = true;
      return d;
    });
    expect((await channel.next()).value).toBe(r);
    await tick();
    expect(settled).toBe(false);
    e.reply({ kind: 'once', requestId: r.id });
    expect(await pending).toEqual({ kind: 'allow' });
  });

  it('ignores a reply whose id no pending check holds', async () => {
    const e = createMockPermissionEngine({ 'curl x': 'ask' });
    const r = req('curl x');
    let settled = false;
    const pending = e.check(r).then((d) => {
      settled = true;
      return d;
    });
    e.reply({ kind: 'once', requestId: 'request-that-is-not-pending' });
    await tick();
    expect(settled).toBe(false);
    e.reply({ kind: 'reject', feedback: 'no', requestId: r.id });
    expect(await pending).toEqual({ kind: 'deny', reason: 'no' });
  });

  it('answers the request a reply names when two are pending', async () => {
    const e = createMockPermissionEngine({ a: 'ask', b: 'ask' });
    const first = req('a');
    const second = req('b');
    let firstSettled = false;
    const p1 = e.check(first).then((d) => {
      firstSettled = true;
      return d;
    });
    const p2 = e.check(second);
    e.reply({ kind: 'once', requestId: second.id });
    expect(await p2).toEqual({ kind: 'allow' });
    await tick();
    expect(firstSettled).toBe(false);
    e.reply({ kind: 'reject', feedback: 'no', requestId: first.id });
    expect(await p1).toEqual({ kind: 'deny', reason: 'no' });
  });

  it('refuses a second check whose id is already waiting', async () => {
    const e = createMockPermissionEngine({ x: 'ask' });
    const r = req('x');
    const first = e.check(r);
    const again = await e.check(r);
    expect(again.kind).toBe('deny');
    e.reply({ kind: 'once', requestId: r.id });
    expect(await first).toEqual({ kind: 'allow' });
  });

  it('treats a reply of an unknown kind as a rejection', async () => {
    const e = createMockPermissionEngine({ x: 'ask' });
    const r = req('x');
    const pending = e.check(r);
    // a value from outside the typed seam, parsed into the typed variable (no cast)
    const odd: PermissionReply = JSON.parse(`{"kind":"bogus","requestId":"${r.id}"}`);
    e.reply(odd);
    expect(await pending).toEqual({ kind: 'deny', reason: UNRECOGNISED_REPLY });
  });

  it('records every check and reply in order, and remembers setMode', async () => {
    const e = createMockPermissionEngine({ a: 'allow' });
    await e.check(req('a'));
    e.reply({ kind: 'always', cascade: true, requestId: 'request-none' });
    e.setMode('yolo');
    expect(e.recorder.map((r) => r.kind)).toEqual(['check', 'reply']);
    expect(e.recorder[0]?.decision).toBe('allow');
    expect(e.recorder.at(-1)?.reply).toEqual({
      kind: 'always',
      cascade: true,
      requestId: 'request-none',
    });
    expect(e.approvalMode).toBe('yolo');
  });

  it('falls back to the default decision for unknown keys (and policy may be omitted)', async () => {
    const e = createMockPermissionEngine(undefined, { defaultDecision: 'deny' });
    expect((await e.check(req('anything'))).kind).toBe('deny');
  });

  it('disposeAll settles pending checks as deny and leaves the requests channel open', async () => {
    const e = createMockPermissionEngine({ x: 'ask' });
    const channel = e.requests[Symbol.asyncIterator]();
    const pending = e.check(req('x'));
    await channel.next();
    e.disposeAll('test teardown');
    expect(await pending).toEqual({ kind: 'deny', reason: 'test teardown' });
    const second = req('x');
    void e.check(second);
    const again = await channel.next();
    expect(again.done).toBe(false);
    expect(again.value).toBe(second);
    e.disposeAll('test teardown');
  });

  it('drops a surfaced request nobody read when it disposes, so the next one shown is the new one', async () => {
    const e = createMockPermissionEngine({ x: 'ask' });
    const pending = e.check(req('x'));
    e.disposeAll('test teardown');
    expect(await pending).toEqual({ kind: 'deny', reason: 'test teardown' });
    const next = req('x');
    void e.check(next);
    const shown = await e.requests[Symbol.asyncIterator]().next();
    expect(shown.done).toBe(false);
    expect(shown.value).toBe(next);
    e.disposeAll('test teardown');
  });
});
