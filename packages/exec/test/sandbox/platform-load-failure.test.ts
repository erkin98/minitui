import { describe, it, expect } from 'vitest';
import { probeSandbox, type LoadSandboxRuntime } from '../../src/sandbox/platform.js';

describe('probeSandbox, runtime missing at load', () => {
  it('degrades to unsupported, carrying the error text, when the loader rejects', async () => {
    // A REAL fake loader that rejects as the memoized dynamic import does when the runtime is absent.
    const loadRuntime: LoadSandboxRuntime = async () => {
      throw new Error("Cannot find module '@anthropic-ai/sandbox-runtime'");
    };
    const p = await probeSandbox(loadRuntime);
    expect(p.supported).toBe(false);
    expect(p.errors.join(' ')).toContain('Cannot find module');
  });
});
