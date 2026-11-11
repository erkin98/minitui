import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandboxManager } from '../../src/sandbox/index.js';
import { resetSessionForTest } from '../../src/sandbox/manager.js';
import type { LoadSandboxRuntime } from '../../src/sandbox/platform.js';
import { SandboxUnavailableError } from '../../src/errors.js';

// A handle row passes no write root unless the root is what it tests, so the write-root existence
// check can never be what refuses the wrap under test.
const emptyPolicy = { allowWrite: [] as string[], allowEgress: [] as string[] };

/**
 * A REAL fake loader whose checkDependencies/isSupportedPlatform drive the probe's supported-ness
 * through the production seam — no module replacement. The healthy runtime is STATEFUL: its wrap
 * members throw unless initialize ran first, so a handle path that skipped session init would fail
 * loudly instead of silently returning (init-before-wrap positive control). A `throws` loader models
 * an unloadable runtime; the wrap members return platform-agnostic markers so the delegation
 * assertions hold on every CI OS. `calls`, when given, counts every load (before a `throws` load
 * fails) and every initialize.
 */
function fakeLoader(opts: {
  supportedPlatform?: boolean;
  errors?: string[];
  throws?: boolean;
  calls?: { load: number; initialize: number };
}): LoadSandboxRuntime {
  return async () => {
    if (opts.calls) opts.calls.load++;
    if (opts.throws) throw new Error('Cannot find module');
    let initialized = false;
    return {
      SandboxManager: {
        isSupportedPlatform: () => opts.supportedPlatform ?? true,
        checkDependencies: () => ({ errors: opts.errors ?? [], warnings: [] }),
        initialize: async () => {
          if (opts.calls) opts.calls.initialize++;
          initialized = true;
        },
        reset: async () => {
          initialized = false;
        },
        wrapWithSandbox: async (cmd: string) => {
          if (!initialized) throw new Error('wrap before initialize');
          return `WRAPPED(${cmd})`;
        },
        wrapWithSandboxArgv: async (cmd: string) => {
          if (!initialized) throw new Error('wrap before initialize');
          return { argv: ['SANDBOXED', cmd], env: {} };
        },
        getSandboxViolationStore: () => ({ getViolationsForCommand: () => [] }),
      },
    };
  };
}

const healthy = fakeLoader({ supportedPlatform: true });
// Honest unsupported flavor: the runtime itself failed to load.
const unloadable = fakeLoader({ throws: true });

interface RuntimeHooks {
  /** Fatal dependency errors: a non-empty list makes the handle inactive. */
  readonly errors?: readonly string[];
  /** Runs inside each new initialisation; a rejection fails that initialisation. */
  readonly initialize?: () => Promise<void>;
  /**
   * Runs at the start of every reset, before the context is cleared (the runtime first kills its
   * bridge processes); a rejection is the reset rejecting.
   */
  readonly reset?: () => Promise<void>;
  /** Runs at the start of every wrap; a rejection is the runtime's wrap rejecting. */
  readonly wrap?: () => Promise<void>;
  /** Runs after a wrap's context check, before it returns: a row holds a live wrap open here. */
  readonly beforeReturn?: () => Promise<void>;
}

/**
 * A REAL runtime double that copies the installed runtime's session lifecycle: `initialize` joins
 * an initialisation that is already set (in flight or done) instead of starting another, `reset`
 * clears it only after its own wait, and every wrap throws unless a session context is set. One
 * object serves every load, as the memoized dynamic import does. `calls` records what the handle
 * paths reached; a wrap is counted on entry, so a wrap that reaches the runtime is seen even when it
 * then throws. `events` orders each initialize call against each completed reset.
 */
function makeRuntime(hooks: RuntimeHooks = {}) {
  const calls = { load: 0, initialize: 0, reset: 0, wrap: 0, cleanup: 0 };
  const events: string[] = [];
  let initialization: Promise<void> | undefined;
  let context = false;
  async function wrapped<T>(result: T): Promise<T> {
    calls.wrap++;
    await hooks.wrap?.();
    if (!context) throw new Error('wrap without a session context');
    await hooks.beforeReturn?.();
    return result;
  }
  const runtime = {
    SandboxManager: {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ errors: [...(hooks.errors ?? [])], warnings: [] as string[] }),
      initialize: async () => {
        calls.initialize++;
        events.push('initialize');
        initialization ??= (async () => {
          try {
            await hooks.initialize?.();
            context = true;
          } catch (err: unknown) {
            initialization = undefined;
            throw err;
          }
        })();
        await initialization;
      },
      reset: async () => {
        calls.reset++;
        await hooks.reset?.();
        context = false;
        initialization = undefined;
        events.push('reset');
      },
      wrapWithSandbox: async (cmd: string) => wrapped(`WRAPPED(${cmd})`),
      wrapWithSandboxArgv: async (cmd: string) => wrapped({ argv: ['SANDBOXED', cmd], env: {} }),
      getSandboxViolationStore: () => ({
        getViolationsForCommand: () => [{ line: 'sandbox: deny(1) file-write-create /tmp/x' }],
      }),
      cleanupAfterCommand: () => {
        calls.cleanup++;
      },
    },
  };
  const loadRuntime: LoadSandboxRuntime = async () => {
    calls.load++;
    return runtime;
  };
  return { loadRuntime, calls, events };
}

/** A promise a row opens or fails by hand: holds an initialise or a reset open. */
function gate() {
  let open: () => void = () => undefined;
  let fail: (err: unknown) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    open = () => resolve();
    fail = reject;
  });
  return { promise, open, fail }; // the executor ran synchronously: both are the real settlers
}

/** Let every promise chain that can run, run: the row then asserts on what has NOT happened yet. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(() => resolve());
  });
}

describe('createSandboxManager — supported', () => {
  beforeEach(resetSessionForTest);

  it('active and delegates the uniform argv wrap to the manager (fresh handle resolves)', async () => {
    const m = await createSandboxManager(healthy);
    expect(m.active).toBe(true);
    const w = await m.wrapArgv('ffmpeg -i a out', emptyPolicy);
    expect(w.argv).toEqual(['SANDBOXED', 'ffmpeg -i a out']);
  });

  // wrapCommand is the posix shell-string path (the string wrap throws on win32 by design); the
  // win32 refusal is covered deterministically in the manager suite via an explicit platform arg.
  it.skipIf(process.platform === 'win32')(
    'delegates the posix string wrap when active',
    async () => {
      const m = await createSandboxManager(healthy);
      expect(await m.wrapCommand('ffmpeg -i a out', emptyPolicy)).toBe('WRAPPED(ffmpeg -i a out)');
    },
  );

  it('assertGatable allows every kind when active', async () => {
    const m = await createSandboxManager(healthy);
    for (const k of ['render-local', 'exec-local', 'exec-mcp', 'agent-callback'] as const) {
      expect(() => m.assertGatable(k)).not.toThrow();
    }
  });
});

describe('createSandboxManager — FAIL CLOSED', () => {
  beforeEach(resetSessionForTest);

  it('inactive when the sandbox runtime fails to load', async () => {
    expect((await createSandboxManager(unloadable)).active).toBe(false);
  });

  it('wrapCommand throws SandboxUnavailableError (never runs gated unsandboxed)', async () => {
    const calls = { load: 0, initialize: 0 };
    const m = await createSandboxManager(fakeLoader({ throws: true, calls }));
    const wrap = m.wrapCommand('rm -rf /', emptyPolicy);
    await expect(wrap).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(wrap).rejects.toThrow(/^sandbox unavailable \(/);
    expect(calls).toEqual({ load: 1, initialize: 0 }); // the probe's own load is the only one
  });

  it('wrapArgv throws SandboxUnavailableError', async () => {
    const calls = { load: 0, initialize: 0 };
    const m = await createSandboxManager(fakeLoader({ throws: true, calls }));
    const wrap = m.wrapArgv('rm -rf /', emptyPolicy);
    await expect(wrap).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(wrap).rejects.toThrow(/^sandbox unavailable \(/);
    expect(calls).toEqual({ load: 1, initialize: 0 }); // the probe's own load is the only one
  });

  it('assertGatable allows ONLY render-local; every gated kind throws', async () => {
    const m = await createSandboxManager(unloadable);
    expect(() => m.assertGatable('render-local')).not.toThrow();
    for (const k of ['exec-local', 'exec-mcp', 'agent-callback'] as const) {
      expect(() => m.assertGatable(k)).toThrow(SandboxUnavailableError);
    }
  });

  it('violationsFor is inert (empty) when inactive — never touches the runtime', async () => {
    // The unloadable loader THROWS on load, so if violationsFor reached the manager it would reject;
    // resolving cleanly to [] proves it short-circuited before any loader/manager touch.
    const m = await createSandboxManager(unloadable);
    expect(await m.violationsFor('anything')).toEqual([]);
  });
});

describe('createSandboxManager — session and wrap failures after a healthy probe', () => {
  beforeEach(resetSessionForTest);

  it('a failed initialize rejects wrapArgv and returns nothing; a retry initializes again and wraps', async () => {
    let attempts = 0;
    const rt = makeRuntime({
      initialize: async () => {
        attempts++;
        if (attempts === 1) throw new Error('initialize failed');
      },
    });
    const m = await createSandboxManager(rt.loadRuntime);
    await expect(m.wrapArgv('echo hi', emptyPolicy)).rejects.toBeInstanceOf(Error);
    expect(rt.calls.wrap).toBe(0);
    await expect(m.wrapArgv('echo hi', emptyPolicy)).resolves.toEqual({
      argv: ['SANDBOXED', 'echo hi'],
      env: {},
    });
    expect(rt.calls.initialize).toBe(2);
  });

  it('a failed initialize rejects wrapCommand (the string path)', async () => {
    const rt = makeRuntime({
      initialize: async () => {
        throw new Error('initialize failed');
      },
    });
    const m = await createSandboxManager(rt.loadRuntime);
    await expect(m.wrapCommand('echo hi', emptyPolicy)).rejects.toBeInstanceOf(Error);
    expect(rt.calls.wrap).toBe(0);
  });

  it('a rejected runtime argv wrap rejects wrapArgv, never the raw argv', async () => {
    const rt = makeRuntime({
      wrap: async () => {
        throw new Error('runtime wrap failed');
      },
    });
    const m = await createSandboxManager(rt.loadRuntime);
    await expect(m.wrapArgv('echo hi', emptyPolicy)).rejects.toThrow('runtime wrap failed');
  });

  it('a session-init failure surfaces as SandboxUnavailableError carrying the original error as its cause', async () => {
    const boom = new Error('initialize failed');
    const rt = makeRuntime({
      initialize: async () => {
        throw boom;
      },
    });
    const m = await createSandboxManager(rt.loadRuntime);
    const wrap = m.wrapArgv('echo hi', emptyPolicy);
    await expect(wrap).rejects.toMatchObject({ name: 'SandboxUnavailableError', cause: boom });
    // toMatchObject compares errors by value; the cause must be the original object itself.
    await expect(wrap).rejects.toSatisfy(
      (err: unknown) => err instanceof SandboxUnavailableError && err.cause === boom,
    );
  });

  it('a SandboxUnavailableError raised inside session init reaches the caller as the same object, no cause added', async () => {
    const own = new SandboxUnavailableError('refused inside the session');
    const rt = makeRuntime({
      initialize: async () => {
        throw own;
      },
    });
    const m = await createSandboxManager(rt.loadRuntime);
    await expect(m.wrapArgv('echo hi', emptyPolicy)).rejects.toBe(own);
    expect(own.cause).toBeUndefined();
  });
});

describe('createSandboxManager — dispose', () => {
  beforeEach(resetSessionForTest);

  it('after one wrap, dispose() returns a promise and releases the session through one reset', async () => {
    const rt = makeRuntime();
    const m = await createSandboxManager(rt.loadRuntime);
    await m.wrapArgv('echo hi', emptyPolicy);
    const released = m.dispose();
    expect(released).toBeInstanceOf(Promise);
    await released;
    expect(rt.calls.reset).toBe(1);
  });

  it('a second dispose() adds no reset', async () => {
    const rt = makeRuntime();
    const m = await createSandboxManager(rt.loadRuntime);
    await m.wrapArgv('echo hi', emptyPolicy);
    await m.dispose();
    await m.dispose();
    expect(rt.calls.reset).toBe(1);
  });

  it('before any wrap, dispose() neither loads the runtime again nor resets, and initialize never ran', async () => {
    const rt = makeRuntime();
    const m = await createSandboxManager(rt.loadRuntime);
    await m.dispose();
    expect(rt.calls).toMatchObject({ load: 1, initialize: 0, reset: 0 });
  });

  it('after dispose() every wrap rejects, initialize is not called again, and violationsFor and cleanup are inert', async () => {
    const rt = makeRuntime();
    const m = await createSandboxManager(rt.loadRuntime);
    await m.wrapArgv('echo hi', emptyPolicy);
    expect(await m.violationsFor('echo hi')).toHaveLength(1);
    m.cleanup();
    const cleanups = rt.calls.cleanup; // 1 on linux, 0 elsewhere: the runtime cleanup is linux-only
    await m.dispose();
    await expect(m.wrapArgv('echo again', emptyPolicy)).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
    await expect(m.wrapCommand('echo again', emptyPolicy)).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
    expect(rt.calls.initialize).toBe(1);
    expect(await m.violationsFor('echo hi')).toEqual([]);
    m.cleanup();
    expect(rt.calls.cleanup).toBe(cleanups);
  });

  it('a second handle created after dispose() runs initialize once more (two in total) and wraps', async () => {
    const rt = makeRuntime();
    const first = await createSandboxManager(rt.loadRuntime);
    await first.wrapArgv('echo one', emptyPolicy);
    await first.dispose();
    const second = await createSandboxManager(rt.loadRuntime);
    await expect(second.wrapArgv('echo two', emptyPolicy)).resolves.toEqual({
      argv: ['SANDBOXED', 'echo two'],
      env: {},
    });
    expect(rt.calls.initialize).toBe(2);
    await second.dispose();
  });

  it('after a failed initialise, dispose() resolves and runs no reset', async () => {
    const rt = makeRuntime({
      initialize: async () => {
        throw new Error('initialize failed');
      },
    });
    const m = await createSandboxManager(rt.loadRuntime);
    await expect(m.wrapArgv('echo hi', emptyPolicy)).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
    await expect(m.dispose()).resolves.toBeUndefined();
    expect(rt.calls.reset).toBe(0);
  });

  it('dispose() called while initialize is in flight waits for it and still ends with one reset', async () => {
    const init = gate();
    const rt = makeRuntime({ initialize: () => init.promise });
    const m = await createSandboxManager(rt.loadRuntime);
    const refused = expect(m.wrapArgv('echo hi', emptyPolicy)).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
    await settle();
    expect(rt.calls.initialize).toBe(1);
    const released = m.dispose();
    init.open();
    await released;
    await refused;
    expect(rt.calls.reset).toBe(1);
  });

  it('dispose() called twice at once with reset held: neither call settles until the release, and reset ran once', async () => {
    const hold = gate();
    const rt = makeRuntime({ reset: () => hold.promise });
    const m = await createSandboxManager(rt.loadRuntime);
    await m.wrapArgv('echo hi', emptyPolicy);
    const a = m.dispose();
    const b = m.dispose();
    expect(b).toBe(a); // every call returns the first call's promise
    const settled: string[] = [];
    const first = a.then(() => {
      settled.push('first');
    });
    const second = b.then(() => {
      settled.push('second');
    });
    await settle();
    expect(settled).toEqual([]);
    expect(rt.calls.reset).toBe(1);
    hold.open();
    await Promise.all([first, second]);
    expect(settled).toEqual(['first', 'second']);
    expect(rt.calls.reset).toBe(1);
  });

  it('dispose() while initialize is held, then a new handle wraps: initialize ran twice and the new handle has a live session', async () => {
    const init = gate();
    const rt = makeRuntime({ initialize: () => init.promise });
    const a = await createSandboxManager(rt.loadRuntime);
    const refused = expect(a.wrapArgv('echo a', emptyPolicy)).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
    await settle();
    const released = a.dispose();
    init.open();
    await released;
    await refused;
    const b = await createSandboxManager(rt.loadRuntime);
    // a wrap on the runtime the first handle reset would throw: it has no session context
    await expect(b.wrapArgv('echo b', emptyPolicy)).resolves.toEqual({
      argv: ['SANDBOXED', 'echo b'],
      env: {},
    });
    expect(rt.calls.initialize).toBe(2);
    await b.dispose();
  });

  it('a wrap waiting on the held initialise when dispose() is called rejects, and the runtime wrap is never called', async () => {
    const init = gate();
    const rt = makeRuntime({ initialize: () => init.promise });
    const m = await createSandboxManager(rt.loadRuntime);
    const refused = expect(m.wrapArgv('echo hi', emptyPolicy)).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
    await settle();
    const released = m.dispose();
    init.open();
    await released;
    await refused;
    expect(rt.calls.wrap).toBe(0);
  });

  it('a second handle created while reset is held does not initialize until the release, then initializes after reset resolved', async () => {
    const hold = gate();
    const rt = makeRuntime({ reset: () => hold.promise });
    const a = await createSandboxManager(rt.loadRuntime);
    await a.wrapArgv('echo a', emptyPolicy);
    const released = a.dispose();
    await settle();
    expect(rt.calls.reset).toBe(1); // the release is running
    const b = await createSandboxManager(rt.loadRuntime);
    const wrapped = expect(b.wrapArgv('echo b', emptyPolicy)).resolves.toEqual({
      argv: ['SANDBOXED', 'echo b'],
      env: {},
    });
    await settle();
    expect(rt.calls.initialize).toBe(1);
    hold.open();
    await released;
    await wrapped;
    expect(rt.events).toEqual(['initialize', 'reset', 'initialize']);
    await b.dispose();
  });

  it('an initialise that fails after dispose() was called: dispose() resolves and no reset ran', async () => {
    const init = gate();
    const rt = makeRuntime({ initialize: () => init.promise });
    const m = await createSandboxManager(rt.loadRuntime);
    const refused = expect(m.wrapArgv('echo hi', emptyPolicy)).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
    await settle();
    const released = m.dispose();
    init.fail(new Error('initialize failed late'));
    await expect(released).resolves.toBeUndefined();
    await refused;
    expect(rt.calls.reset).toBe(0);
  });

  it('a rejecting reset: dispose() rejects with it, a second call returns the same rejection, and the handle stays final', async () => {
    const boom = new Error('reset failed');
    const rt = makeRuntime({
      reset: async () => {
        throw boom;
      },
    });
    const m = await createSandboxManager(rt.loadRuntime);
    await m.wrapArgv('echo hi', emptyPolicy);
    const released = m.dispose();
    await expect(released).rejects.toBe(boom);
    const again = m.dispose();
    expect(again).toBe(released);
    await expect(again).rejects.toBe(boom);
    await expect(m.wrapArgv('echo again', emptyPolicy)).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
    expect(rt.calls).toMatchObject({ initialize: 1, reset: 1 });
  });

  it('a wrap whose runtime call is held open and completes after dispose() was called rejects (argv path)', async () => {
    const hold = gate();
    const rt = makeRuntime({ beforeReturn: () => hold.promise });
    const m = await createSandboxManager(rt.loadRuntime);
    const refused = expect(m.wrapArgv('echo hi', emptyPolicy)).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
    await settle();
    expect(rt.calls.wrap).toBe(1); // the runtime wrap passed its context check and is held open
    const released = m.dispose();
    hold.open();
    await released;
    await refused;
  });

  it('a wrap whose runtime call is held open and completes after dispose() was called rejects (string path)', async () => {
    const hold = gate();
    const rt = makeRuntime({ beforeReturn: () => hold.promise });
    const m = await createSandboxManager(rt.loadRuntime);
    const refused = expect(m.wrapCommand('echo hi', emptyPolicy)).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
    await settle();
    expect(rt.calls.wrap).toBe(1); // the runtime wrap passed its context check and is held open
    const released = m.dispose();
    hold.open();
    await released;
    await refused;
  });

  it('on an inactive handle dispose() resolves and touches nothing', async () => {
    const rt = makeRuntime({ errors: ['bubblewrap (bwrap) not found'] });
    const m = await createSandboxManager(rt.loadRuntime);
    expect(m.active).toBe(false);
    await expect(m.dispose()).resolves.toBeUndefined();
    expect(rt.calls).toEqual({ load: 1, initialize: 0, reset: 0, wrap: 0, cleanup: 0 });
  });
});

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A policy rejection of `root`: its message starts with the fixed prefix naming that root. */
const writeRootRejection = (root: string): RegExp =>
  new RegExp(`^${escapeRegExp(`sandbox policy rejected: write root ${JSON.stringify(root)} `)}`);

describe('createSandboxManager — the write-root policy is checked before any session work', () => {
  beforeEach(resetSessionForTest);

  it('a write root that does not exist is refused on both wraps and initialize never runs', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'write-root-')), 'missing');
    const rt = makeRuntime();
    const m = await createSandboxManager(rt.loadRuntime);
    const policy = { allowWrite: [root], allowEgress: [] };
    await expect(m.wrapArgv('echo hi', policy)).rejects.toThrow(writeRootRejection(root));
    await expect(m.wrapCommand('echo hi', policy)).rejects.toThrow(writeRootRejection(root));
    expect(rt.calls.initialize).toBe(0);
  });

  it('a lexically bad root that exists is refused by the builder before initialize, with its reason', async () => {
    const root = `${mkdtempSync(join(tmpdir(), 'write-root-'))}/`;
    const rt = makeRuntime();
    const m = await createSandboxManager(rt.loadRuntime);
    const wrap = m.wrapArgv('echo hi', { allowWrite: [root], allowEgress: [] });
    await expect(wrap).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(wrap).rejects.toThrow(
      `sandbox policy rejected: write root ${JSON.stringify(root)} is not a normalised absolute path`,
    );
    expect(rt.calls.initialize).toBe(0);
  });

  it('a hostile egress entry is refused before initialize', async () => {
    const rt = makeRuntime();
    const m = await createSandboxManager(rt.loadRuntime);
    await expect(
      m.wrapArgv('echo hi', { allowWrite: [], allowEgress: ['*'] }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(rt.calls.initialize).toBe(0);
  });

  it('a root whose stat fails (an over-long name) is a policy rejection, never a raw error', async () => {
    const root = `/${'x'.repeat(300)}`;
    const rt = makeRuntime();
    const m = await createSandboxManager(rt.loadRuntime);
    const wrap = m.wrapArgv('echo hi', { allowWrite: [root], allowEgress: [] });
    await expect(wrap).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(wrap).rejects.toThrow(writeRootRejection(root));
    expect(rt.calls.initialize).toBe(0);
  });

  it('an existing temporary directory is accepted and reaches the runtime wrap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'write-root-'));
    const rt = makeRuntime();
    const m = await createSandboxManager(rt.loadRuntime);
    await expect(m.wrapArgv('echo hi', { allowWrite: [root], allowEgress: [] })).resolves.toEqual({
      argv: ['SANDBOXED', 'echo hi'],
      env: {},
    });
    expect(rt.calls.wrap).toBe(1);
  });
});
