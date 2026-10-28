import { describe, it, expect } from 'vitest';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { buildSandboxConfig } from '../../src/sandbox/config.js';
import {
  probeSandbox,
  type ExecSandboxConfig,
  type LoadSandboxRuntime,
} from '../../src/sandbox/platform.js';

/**
 * A REAL fake runtime loader: a genuine async function returning an object whose
 * `isSupportedPlatform` and `checkDependencies` drive every probe branch through the production
 * seam, with no module replacement. The session and wrap members are never reached by the probe,
 * so they throw if they ever are.
 */
function fakeLoader(probe: {
  isSupportedPlatform: () => boolean;
  checkDependencies: () => { errors: string[]; warnings: string[] };
}): LoadSandboxRuntime {
  const unreachable = async (): Promise<never> => {
    throw new Error('runtime member reached by the probe');
  };
  return async () => ({
    SandboxManager: {
      ...probe,
      initialize: unreachable,
      reset: unreachable,
      wrapWithSandbox: unreachable,
      wrapWithSandboxArgv: unreachable,
      getSandboxViolationStore: () => {
        throw new Error('runtime member reached by the probe');
      },
    },
  });
}

describe('probeSandbox', () => {
  it('reports supported, with no errors and the warnings passed through, for a healthy runtime', async () => {
    const p = await probeSandbox(
      fakeLoader({
        isSupportedPlatform: () => true,
        checkDependencies: () => ({ errors: [], warnings: ['seccomp not available'] }),
      }),
    );
    expect(p.supported).toBe(true);
    expect(p.errors).toEqual([]);
    expect(p.warnings).toEqual(['seccomp not available']);
    expect(p.platform).toBe(process.platform);
  });

  it('reports unsupported when the runtime has a fatal dependency error', async () => {
    const p = await probeSandbox(
      fakeLoader({
        isSupportedPlatform: () => true,
        checkDependencies: () => ({ errors: ['bubblewrap (bwrap) not found'], warnings: [] }),
      }),
    );
    expect(p.supported).toBe(false);
    expect(p.errors).toEqual(['bubblewrap (bwrap) not found']);
  });

  it('reports unsupported when the platform is unsupported, even with no dependency errors', async () => {
    const p = await probeSandbox(
      fakeLoader({
        isSupportedPlatform: () => false,
        checkDependencies: () => ({ errors: [], warnings: [] }),
      }),
    );
    expect(p.supported).toBe(false);
  });

  it('fails closed and carries the error text when a probe member throws, without throwing itself', async () => {
    const p = await probeSandbox(
      fakeLoader({
        isSupportedPlatform: () => {
          throw new Error('probe exploded');
        },
        checkDependencies: () => ({ errors: [], warnings: [] }),
      }),
    );
    expect(p.supported).toBe(false);
    expect(p.errors.join(' ')).toContain('probe exploded');
  });
});

describe('ExecSandboxConfig', () => {
  it('the config exec builds is assignable to the runtime config type (checked by the test type-check)', () => {
    const execConfig: ExecSandboxConfig = buildSandboxConfig({ allowWrite: [], allowEgress: [] });
    const _c: SandboxRuntimeConfig = execConfig;
    expect(_c).toBe(execConfig);
  });
});
