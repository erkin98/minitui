import { describe, it, expect } from 'vitest';
import { MinituiError, SandboxUnavailableError } from '../../src/errors.js';

describe('sandbox errors', () => {
  it('SandboxUnavailableError carries a fail-closed reason and name', () => {
    const err = new SandboxUnavailableError('sandbox runtime failed to load: Cannot find module');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MinituiError);
    expect(err.name).toBe('SandboxUnavailableError');
    expect(err.message).toContain('failed to load');
  });
});
