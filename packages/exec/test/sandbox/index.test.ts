import { describe, it, expect, beforeEach } from 'vitest';
import { createSandboxManager } from '../../src/sandbox/index.js';
import { resetSessionForTest } from '../../src/sandbox/manager.js';
import type { LoadSandboxRuntime } from '../../src/sandbox/platform.js';
import { SandboxUnavailableError } from '../../src/errors.js';

const policy = { allowWrite: ['/work'], allowEgress: [] as string[] };

/**
 * A REAL fake loader whose checkDependencies/isSupportedPlatform drive the probe's supported-ness
 * through the production seam — no module replacement. The healthy runtime is STATEFUL: its wrap
 * members throw unless initialize ran first, so a handle path that skipped session init would fail
 * loudly instead of silently returning (init-before-wrap positive control). A `throws` loader models
 * an unloadable runtime; the wrap members return platform-agnostic markers so the delegation
 * assertions hold on every CI OS.
 */
function fakeLoader(opts: {
  supportedPlatform?: boolean;
  errors?: string[];
  throws?: boolean;
}): LoadSandboxRuntime {
  return async () => {
    if (opts.throws) throw new Error('Cannot find module');
    let initialized = false;
    return {
      SandboxManager: {
        isSupportedPlatform: () => opts.supportedPlatform ?? true,
        checkDependencies: () => ({ errors: opts.errors ?? [], warnings: [] }),
        initialize: async () => {
          initialized = true;
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
// Honest unsupported flavor: the runtime itself failed to load (win32 alone is NOT unsupported).
const unloadable = fakeLoader({ throws: true });

describe('createSandboxManager — supported', () => {
  beforeEach(resetSessionForTest);

  it('active and delegates the uniform argv wrap to the manager (fresh handle resolves)', async () => {
    const m = await createSandboxManager(healthy);
    expect(m.active).toBe(true);
    const w = await m.wrapArgv('ffmpeg -i a out', policy);
    expect(w.argv).toEqual(['SANDBOXED', 'ffmpeg -i a out']);
  });

  // wrapCommand is the posix shell-string path (the string wrap throws on win32 by design); the
  // win32 refusal is covered deterministically in the manager suite via an explicit platform arg.
  it.skipIf(process.platform === 'win32')(
    'delegates the posix string wrap when active',
    async () => {
      const m = await createSandboxManager(healthy);
      expect(await m.wrapCommand('ffmpeg -i a out', policy)).toBe('WRAPPED(ffmpeg -i a out)');
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
    const m = await createSandboxManager(unloadable);
    await expect(m.wrapCommand('rm -rf /', policy)).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it('wrapArgv throws SandboxUnavailableError', async () => {
    const m = await createSandboxManager(unloadable);
    await expect(m.wrapArgv('rm -rf /', policy)).rejects.toBeInstanceOf(SandboxUnavailableError);
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
