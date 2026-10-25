import { describe, it, expect } from 'vitest';
import { MinituiError, SandboxUnavailableError, SandboxViolationError } from '../../src/errors.js';

describe('sandbox errors', () => {
  it('SandboxUnavailableError carries a fail-closed reason and name', () => {
    const err = new SandboxUnavailableError('sandbox runtime failed to load: Cannot find module');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MinituiError);
    expect(err.name).toBe('SandboxUnavailableError');
    expect(err.message).toContain('failed to load');
  });

  it('SandboxViolationError carries the structured violation', () => {
    const err = new SandboxViolationError({
      kind: 'fs-write',
      reason: 'write denied: /etc/passwd',
      path: '/etc/passwd',
    });
    expect(err).toBeInstanceOf(MinituiError);
    expect(err.name).toBe('SandboxViolationError');
    expect(err.violation.kind).toBe('fs-write');
    expect(err.violation.path).toBe('/etc/passwd');
    expect(err.message).toBe('write denied: /etc/passwd');
  });
});
