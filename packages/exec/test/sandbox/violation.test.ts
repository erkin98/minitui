import { describe, it, expect } from 'vitest';
import { parseViolationLine, toSandboxViolation } from '../../src/sandbox/violation.js';

describe('parseViolationLine (sandbox violation-store lines)', () => {
  it('parses a deny file-write* store line into fs-write + path', () => {
    const v = parseViolationLine('sandbox: deny(1) file-write-create /Users/x/.ssh/id_rsa');
    expect(v.kind).toBe('fs-write');
    expect(v.path).toBe('/Users/x/.ssh/id_rsa');
    expect(v.reason).toContain('file-write');
  });

  it('unknown store-line format degrades to unknown carrying the raw line', () => {
    const v = parseViolationLine('bwrap: opaque denial text');
    expect(v.kind).toBe('unknown');
    expect(v.reason).toContain('bwrap: opaque denial text');
  });
});

describe('toSandboxViolation (spawn-error fallback)', () => {
  it('macOS: parses a deny file-write* message into fs-write + path', () => {
    const err = new Error('sandbox: deny(1) file-write-create /Users/x/.ssh/id_rsa');
    const v = toSandboxViolation(err, 'darwin');
    expect(v.kind).toBe('fs-write');
    expect(v.path).toBe('/Users/x/.ssh/id_rsa');
    expect(v.reason).toContain('file-write');
  });

  it('macOS: parses a deny network* message into egress', () => {
    const err = new Error('sandbox: deny(1) network-outbound 1.2.3.4:443');
    const v = toSandboxViolation(err, 'darwin');
    expect(v.kind).toBe('egress');
  });

  it('Linux: EPERM errno maps to fs-write by default', () => {
    const err = Object.assign(new Error('spawn EPERM'), { code: 'EPERM', errno: -1 });
    const v = toSandboxViolation(err, 'linux');
    expect(v.kind).toBe('fs-write');
    expect(v.reason).toContain('EPERM');
  });

  it('Linux: EACCES with a path maps to fs-write + path', () => {
    const err = Object.assign(new Error("EACCES: permission denied, open '/etc/shadow'"), {
      code: 'EACCES',
      path: '/etc/shadow',
    });
    const v = toSandboxViolation(err, 'linux');
    expect(v.kind).toBe('fs-write');
    expect(v.path).toBe('/etc/shadow');
  });

  it('unknown shape maps to unknown kind, never throws', () => {
    const v = toSandboxViolation(42, 'linux');
    expect(v.kind).toBe('unknown');
    expect(typeof v.reason).toBe('string');
  });
});
