import { describe, it, expect, beforeEach } from 'vitest';
import {
  initSession,
  wrapCommandWith,
  wrapArgvWith,
  violationsForCommand,
  cleanupAfterCommand,
  resetSessionForTest,
  hardenChildEnv,
} from '../../src/sandbox/manager.js';
import type { LoadSandboxRuntime } from '../../src/sandbox/platform.js';
import { SandboxUnavailableError } from '../../src/errors.js';

const policy = { allowWrite: ['/work'], allowEgress: [] as string[] };

/** Put each variable back as it was: delete what was absent, reassign what was set. */
function restoreEnv(saved: Readonly<Record<string, string | undefined>>): void {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
}

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
      reset: async () => {},
      wrapWithSandbox: async (cmd: string) => {
        if (calls.initialize === 0) throw new Error('wrap before initialize');
        calls.wrapWithSandbox.push(cmd);
        return `sandbox-exec -p '...' /bin/sh -c '${cmd}'`;
      },
      wrapWithSandboxArgv: async (cmd: string, binShell) => {
        if (calls.initialize === 0) throw new Error('wrap before initialize');
        calls.wrapWithSandboxArgv.push([cmd, binShell]);
        return { argv: [binShell ?? 'no shell', '-c', `WRAPPED(${cmd})`], env: process.env };
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

/**
 * A REAL fake runtime whose wraps return what a row hands it for the command: the input of the
 * guard that refuses a command handed back unwrapped.
 */
function unwrappingRuntime(
  argvOf: (cmd: string) => string[],
  stringOf: (cmd: string) => string,
): LoadSandboxRuntime {
  return async () => ({
    SandboxManager: {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ errors: [], warnings: [] }),
      initialize: async () => {},
      reset: async () => {},
      wrapWithSandbox: async (cmd: string) => stringOf(cmd),
      wrapWithSandboxArgv: async (cmd: string) => ({ argv: argvOf(cmd), env: {} }),
      getSandboxViolationStore: () => ({ getViolationsForCommand: () => [] }),
    },
  });
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

  it('the argv wrap refuses win32 before the runtime is reached', async () => {
    const { loadRuntime, calls } = makeFakeRuntime();
    const s = await initSession(policy, loadRuntime);
    await expect(
      wrapArgvWith(s, 'ffmpeg -i a.mp4 out.mp4', policy, 'win32'),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(calls.wrapWithSandboxArgv).toEqual([]);
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

  it('wrapCommandWith fails closed when the per-call egress differs from the initialized session', async () => {
    const { loadRuntime, calls } = makeFakeRuntime();
    const s = await initSession({ allowWrite: ['/work'], allowEgress: [] }, loadRuntime);
    await expect(
      wrapCommandWith(
        s,
        'gh api /repos',
        { allowWrite: ['/work'], allowEgress: ['api.github.com'] },
        'linux',
      ),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(calls.wrapWithSandbox).toEqual([]); // refused before the runtime was reached
  });

  it('wrapArgvWith refuses a runtime that returns an empty argv', async () => {
    const s = await initSession(
      policy,
      unwrappingRuntime(
        () => [],
        (cmd) => `WRAPPED(${cmd})`,
      ),
    );
    await expect(wrapArgvWith(s, 'echo hi', policy, 'linux')).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
  });

  it('wrapArgvWith refuses a runtime that hands the command back unwrapped as the shell script', async () => {
    const s = await initSession(
      policy,
      unwrappingRuntime(
        (cmd) => ['/bin/sh', '-c', cmd],
        (cmd) => `WRAPPED(${cmd})`,
      ),
    );
    await expect(wrapArgvWith(s, 'echo hi', policy, 'linux')).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
  });

  it('wrapCommandWith refuses a runtime that returns the command unchanged', async () => {
    const s = await initSession(
      policy,
      unwrappingRuntime(
        (cmd) => ['/bin/sh', '-c', `WRAPPED(${cmd})`],
        (cmd) => cmd,
      ),
    );
    await expect(wrapCommandWith(s, 'echo hi', policy, 'linux')).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
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
    // process.env assertion below. PATH is set here, not read from the host (whose PATH may hold a
    // relative entry), and comes back with its absolute entries only. Planted values are inert.
    const { loadRuntime } = makeFakeRuntime();
    const s = await initSession(policy, loadRuntime);
    const saved = {
      LD_PRELOAD: process.env.LD_PRELOAD,
      DYLD_INSERT_LIBRARIES: process.env.DYLD_INSERT_LIBRARIES,
      PATH: process.env.PATH,
    };
    process.env.LD_PRELOAD = 'planted-inert-value';
    process.env.DYLD_INSERT_LIBRARIES = 'planted-inert-value';
    process.env.PATH = '/usr/bin:relbin:.::/bin';
    try {
      const w = await wrapArgvWith(s, 'ffmpeg -i a.mp4 out.mp4', policy, 'linux');
      expect(w.env.LD_PRELOAD).toBeUndefined();
      expect(w.env.DYLD_INSERT_LIBRARIES).toBeUndefined();
      expect(w.env.PATH).toBe('/usr/bin:/bin');
      expect(process.env.LD_PRELOAD).toBe('planted-inert-value'); // source env NOT mutated (fresh copy)
    } finally {
      restoreEnv(saved);
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

// The environment rows pass a synthetic environment to hardenChildEnv: nothing is planted in the
// test process. The credential values are inert strings, never a path or an option a child would act on.
const CREDENTIAL_NAMES = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GITHUB_TOKEN',
  'AWS_SESSION_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'PGPASSWORD',
  'DATABASE_URL',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'SSH_AUTH_SOCK',
  'NODE_OPTIONS',
  'BASH_ENV',
  'ENV',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
];

const KEPT: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/child',
  USER: 'child',
  LOGNAME: 'child',
  SHELL: '/bin/sh',
  LANG: 'C.UTF-8',
  LC_ALL: 'C',
  LC_CTYPE: 'C.UTF-8',
  TZ: 'UTC',
  TMPDIR: '/tmp/child',
  TERM: 'xterm-256color',
};

/** A host environment: the kept variables, every credential name, and other variables a host carries. */
function hostEnv(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(CREDENTIAL_NAMES.map((name) => [name, 'planted-inert-value'])),
    ...KEPT,
    EDITOR: 'vi',
    PWD: '/home/child/project',
    SHLVL: '2',
    npm_config_cache: 'planted-inert-value',
    MINITUI_ASRT_VENDOR_DIR: 'planted-inert-value',
  };
}

describe('hardenChildEnv — the environment a sandboxed child receives', () => {
  it('no credential, loader or shell-startup variable reaches the child', () => {
    const child = hardenChildEnv(hostEnv());
    expect(Object.keys(child).filter((name) => CREDENTIAL_NAMES.includes(name))).toEqual([]);
  });

  it('nothing outside the allowlist is passed at all', () => {
    expect(Object.keys(hardenChildEnv(hostEnv())).sort()).toEqual(Object.keys(KEPT).sort());
  });

  it('PATH keeps only its absolute entries, in order', () => {
    expect(hardenChildEnv({ PATH: '/usr/bin:relbin:.::/bin' }).PATH).toBe('/usr/bin:/bin');
  });

  it('the kept variables survive unchanged', () => {
    expect(hardenChildEnv({ ...KEPT })).toEqual(KEPT);
  });

  it('the source environment is not mutated, and the child gets a fresh object', () => {
    const source = hostEnv();
    const before = { ...source };
    const child = hardenChildEnv(source);
    expect(source).toEqual(before);
    expect(child).not.toBe(source);
  });
});
