import { describe, it, expect, beforeEach } from 'vitest';
import {
  initSession,
  wrapCommandWith,
  wrapArgvWith,
  violationsForCommand,
  cleanupAfterCommand,
  resetSessionForTest,
} from '../../src/sandbox/manager.js';
import type { LoadSandboxRuntime } from '../../src/sandbox/platform.js';
import { SandboxUnavailableError } from '../../src/errors.js';

const policy = { allowWrite: ['/work'], allowEgress: [] as string[] };

/**
 * A REAL fake runtime: a genuine object whose sandbox manager records its calls into owned
 * arrays/counters, returned by a real async loader. This is the production injection seam — every
 * "was it called with X" assertion reads the recorded arrays directly, no reflection. The runtime
 * is STATEFUL: every wrap/store member throws unless initialize ran first, so removing the init
 * step would red the wrap tests (init-before-wrap positive control). The argv wrap returns
 * process.env BY REFERENCE (mirroring the real runtime) so the loader-var strip and its non-mutation
 * of the source env both have teeth.
 */
function makeFakeRuntime() {
  const calls = {
    initialize: 0,
    enableLogMonitor: [] as Array<boolean | undefined>,
    wrapWithSandbox: [] as string[],
    wrapWithSandboxArgv: [] as Array<readonly [string, string | undefined]>,
    getViolationsForCommand: [] as string[],
    cleanupAfterCommand: 0,
  };
  const loadRuntime: LoadSandboxRuntime = async () => ({
    SandboxManager: {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ errors: [], warnings: [] }),
      initialize: async (_config, _ask, enableLogMonitor) => {
        calls.initialize++;
        calls.enableLogMonitor.push(enableLogMonitor);
      },
      wrapWithSandbox: async (cmd: string) => {
        if (calls.initialize === 0) throw new Error('wrap before initialize');
        calls.wrapWithSandbox.push(cmd);
        return `sandbox-exec -p '...' /bin/sh -c '${cmd}'`;
      },
      wrapWithSandboxArgv: async (cmd: string, binShell) => {
        if (calls.initialize === 0) throw new Error('wrap before initialize');
        calls.wrapWithSandboxArgv.push([cmd, binShell]);
        return binShell
          ? { argv: [binShell, '-c', `WRAPPED(${cmd})`], env: process.env }
          : { argv: ['srt-win.exe', 'exec', cmd], env: process.env };
      },
      getSandboxViolationStore: () => ({
        getViolationsForCommand: (cmd: string) => {
          if (calls.initialize === 0) throw new Error('wrap before initialize');
          calls.getViolationsForCommand.push(cmd);
          return [
            {
              line: 'sandbox: deny(1) file-write-create /Users/x/.ssh/id_rsa',
              timestamp: new Date(),
            },
          ];
        },
      }),
      cleanupAfterCommand: () => {
        calls.cleanupAfterCommand++;
      },
    },
  });
  return { loadRuntime, calls };
}

describe('sandbox manager', () => {
  beforeEach(() => {
    // Reset the module-level singleton UNCONDITIONALLY so each case starts clean — no cross-test
    // bleed, no dependence on execution order.
    resetSessionForTest();
  });

  it('initSession calls initialize exactly once across repeated calls', async () => {
    const { loadRuntime, calls } = makeFakeRuntime();
    const s1 = await initSession(policy, loadRuntime);
    const s2 = await initSession(policy, loadRuntime);
    expect(calls.initialize).toBe(1);
    expect(s1).toBe(s2); // same global session
  });

  it('enables the violation-log producer only on darwin (the sole store producer)', async () => {
    const { loadRuntime, calls } = makeFakeRuntime();
    await initSession(policy, loadRuntime, 'darwin');
    expect(calls.enableLogMonitor).toEqual([true]);
  });

  it('leaves the violation-log producer off away from darwin', async () => {
    const { loadRuntime, calls } = makeFakeRuntime();
    await initSession(policy, loadRuntime, 'linux');
    expect(calls.enableLogMonitor).toEqual([false]);
  });

  it('wrap after initSession resolves — the stateful runtime proves initialize ran first', async () => {
    const { loadRuntime } = makeFakeRuntime();
    const s = await initSession(policy, loadRuntime, 'linux');
    await expect(wrapArgvWith(s, 'echo hi', policy, 'linux')).resolves.toBeDefined();
  });

  it('wrapCommandWith returns the shell-string wrap on mac/linux', async () => {
    const { loadRuntime, calls } = makeFakeRuntime();
    const s = await initSession(policy, loadRuntime);
    const wrapped = await wrapCommandWith(s, 'ffmpeg -i a.mp4 out.mp4', policy, 'linux');
    expect(wrapped).toContain('ffmpeg -i a.mp4 out.mp4');
    expect(calls.wrapWithSandbox).toEqual(['ffmpeg -i a.mp4 out.mp4']);
  });

  it('wrapCommandWith refuses on win32 with a typed error (the string wrap throws there by design)', async () => {
    const { loadRuntime, calls } = makeFakeRuntime();
    const s = await initSession(policy, loadRuntime);
    await expect(wrapCommandWith(s, 'whatever', policy, 'win32')).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
    expect(calls.wrapWithSandbox).toEqual([]); // refused before the runtime was ever reached
  });

  it('wrapArgvWith returns the uniform {argv,env} descriptor on posix (binShell /bin/sh)', async () => {
    const { loadRuntime, calls } = makeFakeRuntime();
    const s = await initSession(policy, loadRuntime);
    const w = await wrapArgvWith(s, 'ffmpeg -i a.mp4 out.mp4', policy, 'linux');
    expect(w.argv).toEqual(['/bin/sh', '-c', 'WRAPPED(ffmpeg -i a.mp4 out.mp4)']);
    expect(calls.wrapWithSandboxArgv).toEqual([['ffmpeg -i a.mp4 out.mp4', '/bin/sh']]);
  });

  it('wrapArgvWith sandboxes win32 too (binShell undefined → the runtime default)', async () => {
    const { loadRuntime, calls } = makeFakeRuntime();
    const s = await initSession(policy, loadRuntime);
    const w = await wrapArgvWith(s, 'ffmpeg -i a.mp4 out.mp4', policy, 'win32');
    expect(w.argv[0]).toBe('srt-win.exe');
    expect(calls.wrapWithSandboxArgv).toEqual([['ffmpeg -i a.mp4 out.mp4', undefined]]);
  });

  it('wrapArgvWith fails closed when the per-call egress differs from the initialized session', async () => {
    const { loadRuntime, calls } = makeFakeRuntime();
    const s = await initSession({ allowWrite: ['/work'], allowEgress: [] }, loadRuntime);
    await expect(
      wrapArgvWith(
        s,
        'gh api /repos',
        { allowWrite: ['/work'], allowEgress: ['api.github.com'] },
        'linux',
      ),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(calls.wrapWithSandboxArgv).toEqual([]); // refused before the runtime was reached
  });

  it('wrapArgvWith proceeds when the per-call egress set-equals the session (order-insensitive)', async () => {
    const { loadRuntime, calls } = makeFakeRuntime();
    const s = await initSession(
      { allowWrite: ['/work'], allowEgress: ['a.example', 'b.example'] },
      loadRuntime,
    );
    const w = await wrapArgvWith(
      s,
      'gh api',
      { allowWrite: ['/work'], allowEgress: ['b.example', 'a.example'] },
      'linux',
    );
    expect(w.argv).toEqual(['/bin/sh', '-c', 'WRAPPED(gh api)']);
    expect(calls.wrapWithSandboxArgv.length).toBe(1);
  });

  it('violationsForCommand maps store lines to structured host-resolved violations', async () => {
    const { loadRuntime, calls } = makeFakeRuntime();
    const s = await initSession(policy, loadRuntime);
    const violations = violationsForCommand(s, 'cat ~/.ssh/id_rsa > /tmp/x');
    expect(calls.getViolationsForCommand).toEqual(['cat ~/.ssh/id_rsa > /tmp/x']);
    expect(violations).toEqual([
      expect.objectContaining({ kind: 'fs-write', path: '/Users/x/.ssh/id_rsa' }),
    ]);
  });

  it('wrapArgvWith strips loader-injection vars (LD_*/DYLD_*) without mutating process.env', async () => {
    // The fake returns process.env BY REFERENCE, so a buggy in-place strip would be caught by the
    // process.env assertion below.
    const { loadRuntime } = makeFakeRuntime();
    const s = await initSession(policy, loadRuntime);
    process.env.LD_PRELOAD = '/tmp/evil.so';
    process.env.DYLD_INSERT_LIBRARIES = '/tmp/evil.dylib';
    try {
      const w = await wrapArgvWith(s, 'ffmpeg -i a.mp4 out.mp4', policy, 'linux');
      expect(w.env.LD_PRELOAD).toBeUndefined();
      expect(w.env.DYLD_INSERT_LIBRARIES).toBeUndefined();
      expect(w.env.PATH).toBe(process.env.PATH); // ordinary vars pass through untouched
      expect(process.env.LD_PRELOAD).toBe('/tmp/evil.so'); // source env NOT mutated (fresh copy)
    } finally {
      delete process.env.LD_PRELOAD;
      delete process.env.DYLD_INSERT_LIBRARIES;
    }
  });

  it('cleanupAfterCommand routes through the session runtime on linux, no-op elsewhere', async () => {
    const { loadRuntime, calls } = makeFakeRuntime();
    const s = await initSession(policy, loadRuntime, 'linux');
    cleanupAfterCommand(s, 'linux');
    cleanupAfterCommand(s, 'darwin');
    cleanupAfterCommand(s, 'win32');
    expect(calls.cleanupAfterCommand).toBe(1);
  });
});
