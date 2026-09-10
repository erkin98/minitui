import { describe, it, expect } from 'vitest';
import { createEngine } from '../../src/permission/engine.js';
import type { PermissionRequest } from '@minitui/types';

let n = 0;
const exec = (resolvedCommand: string): PermissionRequest => ({
  id: `r${n++}`,
  descriptor: {
    danger: false,
    resourceTemplate: resolvedCommand,
    summaryTemplate: resolvedCommand,
  },
  resolvedCommand,
  resolvedPaths: [],
});

describe('createEngine', () => {
  it('denies a hard-floor command even with an allow rule and YOLO', async () => {
    const e = createEngine({
      initialRules: { rules: [{ pattern: 'curl', effect: 'allow', layer: 'user' }] },
      mode: 'yolo',
    });
    const d = await e.check(exec('curl http://evil'));
    expect(d.kind).toBe('deny');
  });

  it('allows an explicitly-allowed safe command', async () => {
    const e = createEngine({
      initialRules: { rules: [{ pattern: 'ffmpeg', effect: 'allow', layer: 'user' }] },
    });
    const d = await e.check(exec('ffmpeg -i a.mp4 -i b.mp4 out.mp4'));
    expect(d.kind).toBe('allow');
  });

  it('denies the gated root of a compound command (safe && evil)', async () => {
    const e = createEngine({
      initialRules: {
        rules: [
          { pattern: 'ls', effect: 'allow', layer: 'user' },
          { pattern: 'rm', effect: 'deny', layer: 'user' },
        ],
      },
    });
    const d = await e.check(exec('ls && rm -rf /'));
    expect(d.kind).toBe('deny');
  });

  it('blocks on ask and resolves when the UI replies once (reply has no id)', async () => {
    const e = createEngine({ initialRules: { rules: [] } });
    const p = e.check(exec('ffmpeg -i a out'));
    const it = e.requests[Symbol.asyncIterator]();
    await it.next(); // drain the surfaced request
    e.reply({ kind: 'once' }); // canonical reply: kind-keyed, no id
    const d = await p;
    expect(d.kind).toBe('allow');
  });

  it('YOLO does NOT auto-allow a stdin-fed runner — xargs stays uncertain', async () => {
    // `echo / | xargs rm -rf`: xargs is a recognised root (not opaque, not unsafe-tool-arg), so
    // WITHOUT STDIN_RUNNERS the uncertain predicate is false and YOLO would silently allow — the `/`
    // is laundered through stdin, invisible to the name-based hard floor. It must reach the human.
    const e = createEngine({ initialRules: { rules: [] }, mode: 'yolo' });
    const p = e.check(exec('echo / | xargs rm -rf'));
    const it = e.requests[Symbol.asyncIterator]();
    await it.next(); // it ASKS (surfaces a request) — did NOT auto-allow under YOLO
    e.reply({ kind: 'reject', feedback: 'stdin-laundered target' });
    const d = await p;
    expect(d.kind).toBe('deny');
  });

  it('sanitizes resolvedPaths before the consent UI — ESC/CSI in a resolved path', async () => {
    const e = createEngine({ initialRules: { rules: [] } });
    const req: PermissionRequest = {
      id: 'esc-path',
      descriptor: { danger: false, resourceTemplate: 'ffmpeg', summaryTemplate: 'merge' },
      resolvedCommand: 'ffmpeg -i a out',
      resolvedPaths: ['/abs/\x1b[2Jout.mp4'], // clear-screen CSI laundered through a resolved path
    };
    const p = e.check(req);
    const it = e.requests[Symbol.asyncIterator]();
    const { value } = await it.next();
    expect(value!.resolvedPaths[0]).not.toContain('\x1b'); // stripped — no raw ESC reaches the modal
    e.reply({ kind: 'once' });
    await p;
  });

  it('sanitizes the host-resolved command before it reaches the consent UI', async () => {
    const e = createEngine({ initialRules: { rules: [] } });
    // an OSC/ANSI-laden resolved command must be neutralized on the surfaced request
    const p = e.check(exec('echo \x1b]0;pwned\x07 hi'));
    const it = e.requests[Symbol.asyncIterator]();
    const { value } = await it.next();
    expect(value!.resolvedCommand).not.toContain('\x1b');
    e.reply({ kind: 'once' });
    await p;
  });

  it('always builds a grant and auto-allows the next identical command', async () => {
    const grants: string[] = [];
    const e = createEngine({ initialRules: { rules: [] }, onGrant: (r) => grants.push(r.pattern) });
    const p = e.check(exec('ffmpeg -i a out'));
    const it = e.requests[Symbol.asyncIterator]();
    await it.next();
    e.reply({ kind: 'always', cascade: true });
    await p;
    expect(grants).toEqual(['ffmpeg']);
    // second command with the same cascade root resolves allow without asking
    const d2 = await e.check(exec('ffmpeg -i x out'));
    expect(d2.kind).toBe('allow');
  });

  it('an identity-bound grant stops auto-allowing after a PATH/symlink swap, even under YOLO', async () => {
    // a cascade grant for `ffmpeg` bound to the realpath it was approved for. resolveExecutable is a
    // REAL injected fake (a plain closure over `resolved`, no vi.mock — a real port impl via the seam).
    let resolved = '/usr/bin/ffmpeg';
    const e = createEngine({
      initialRules: {
        rules: [{ pattern: 'ffmpeg', effect: 'allow', layer: 'user', identity: '/usr/bin/ffmpeg' }],
      },
      mode: 'yolo',
      resolveExecutable: () => resolved,
    });
    // same identity → the grant still auto-allows the legit repeat (no false-positive)
    expect((await e.check(exec('ffmpeg -i a out'))).kind).toBe('allow');
    // a mid-session swap: the same bare name now resolves elsewhere → the grant no longer vouches for it
    resolved = '/tmp/evil/ffmpeg';
    const p = e.check(exec('ffmpeg -i a out'));
    const it = e.requests[Symbol.asyncIterator]();
    await it.next(); // it SURFACED an ask despite YOLO (non-liftable), did not auto-allow
    e.disposeAll('swapped');
    expect(await p).toEqual({ kind: 'deny', reason: 'swapped' });
  });

  it('an always-grant can never reach a hard-floor action', async () => {
    const e = createEngine({ initialRules: { rules: [] } });
    // grant [a]lways for a SAFE rm (rm of a plain file is NOT a hard-floor target) — cascade:true
    // builds an allow grant rooted at `rm`, broad enough to match a later bare `rm`.
    const p = e.check(exec('rm build.log'));
    const it = e.requests[Symbol.asyncIterator]();
    await it.next();
    e.reply({ kind: 'always', cascade: true });
    expect((await p).kind).toBe('allow');
    // the grant now allows `rm`, yet a hard-floor rm ($HOME wipe) STILL denies: the hard floor is
    // engine step 1, checked BEFORE the grant triad at step 2, so an always-grant can never lift it
    // (the point where peers' session-allow UX undermines their floor; minitui must not).
    expect((await e.check(exec('rm -rf $HOME'))).kind).toBe('deny');
  });

  it('yolo bypasses ask but never the hard floor', async () => {
    const e = createEngine({ initialRules: { rules: [] }, mode: 'yolo' });
    expect((await e.check(exec('ffmpeg -i a out'))).kind).toBe('allow'); // ask -> allow under yolo
    expect((await e.check(exec('rm -rf $HOME'))).kind).toBe('deny'); // hard floor still bites
  });

  it('denies an unparseable command even under yolo (fail-closed, not ask->allow)', async () => {
    const e = createEngine({ initialRules: { rules: [] }, mode: 'yolo' });
    const d = await e.check(exec('ls "unterminated'));
    expect(d.kind).toBe('deny');
  });

  it('denies an unmodeled construct (subshell) even under yolo — the allowlist feeds the step-0 guard', async () => {
    // `(rm -rf /)` is a syntactically-valid but UNMODELED construct; the positive node-kind
    // allowlist degrades it to parseError, and the step-0 guard hard-denies it before YOLO.
    const e = createEngine({ initialRules: { rules: [] }, mode: 'yolo' });
    const d = await e.check(exec('(rm -rf /)'));
    expect(d.kind).toBe('deny');
  });

  it('denies a substitution command even under yolo (never surfaced to ask)', async () => {
    // shell substitution is a non-YOLO-upgradable DENY at engine step 0.5, mirroring the
    // parseError deny — hard-denied before the hard floor / YOLO bypass and NEVER surfaced to the
    // human. `await e.check(...)` resolving to deny with no reply/dispose is itself the proof that
    // no pending request was surfaced (a surfaced ask would block forever without a reply).
    const e = createEngine({ initialRules: { rules: [] }, mode: 'yolo' });
    const d = await e.check(exec('ffmpeg -i $(echo a).mp4 out'));
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny') expect(d.reason).toContain('shell substitution');
  });

  it('yolo does NOT auto-allow an ffmpeg network-input downgrade — it still asks', async () => {
    // ffmpeg is allowed, but `-i https://…` is the SSRF downgrade to ask; YOLO must NOT lift it
    // (an `ask` YOLO overrides defeats the downgrade). It reaches the human, not auto-allowed.
    const e = createEngine({
      initialRules: { rules: [{ pattern: 'ffmpeg', effect: 'allow', layer: 'user' }] },
      mode: 'yolo',
    });
    const p = e.check(exec('ffmpeg -i https://evil/x.mp4 out.mp4'));
    const it = e.requests[Symbol.asyncIterator]();
    const surfaced = await it.next();
    expect(surfaced.value!.resolvedCommand).toContain('ffmpeg');
    e.disposeAll('done');
    expect(await p).toEqual({ kind: 'deny', reason: 'done' });
  });

  it('yolo does NOT auto-allow a git global-option hijack — it still asks', async () => {
    const e = createEngine({
      initialRules: { rules: [{ pattern: 'git', effect: 'allow', layer: 'user' }] },
      mode: 'yolo',
    });
    const p = e.check(exec('git -c core.pager=touch\\ x log'));
    const it = e.requests[Symbol.asyncIterator]();
    await it.next();
    e.disposeAll('done');
    expect(await p).toEqual({ kind: 'deny', reason: 'done' });
  });

  it('disposeAll fails a pending check as deny so the agent never hangs', async () => {
    const e = createEngine({ initialRules: { rules: [] } });
    const p = e.check(exec('ffmpeg -i a out'));
    const it = e.requests[Symbol.asyncIterator]();
    await it.next(); // wait until the request is actually surfaced (no cold-parser setTimeout race)
    e.disposeAll('cancelled');
    const d = await p;
    expect(d).toEqual({ kind: 'deny', reason: 'cancelled' });
  });
});
