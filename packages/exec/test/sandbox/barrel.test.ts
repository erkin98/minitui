import { describe, it, expect } from 'vitest';
import * as exec from '../../src/index.js';

describe('@minitui/exec barrel — sandbox surface', () => {
  it('re-exports createSandboxManager', () => {
    expect(typeof exec.createSandboxManager).toBe('function');
  });

  it('re-exports the sandbox error class (the integration gate imports it from the package)', () => {
    expect(typeof exec.SandboxUnavailableError).toBe('function');
  });
});
