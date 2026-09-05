import { describe, it, expect } from 'vitest';
import { unwrapArgv, isQualifiedPath } from '../../src/permission/shell/wrappers.js';

describe('unwrapArgv — arg-runners re-resolve the inner command', () => {
  it('peels sudo to the real rm', () => {
    const r = unwrapArgv(['sudo', 'rm', '-rf', '/']);
    expect(r.name).toBe('rm');
    expect(r.argv).toEqual(['rm', '-rf', '/']);
    expect(r.wrappedBy).toEqual(['sudo']);
    expect(r.opaque).toBe(false);
  });
  it('peels env VAR=1 to the real curl', () => {
    const r = unwrapArgv(['env', 'X=1', 'curl', 'http://evil']);
    expect(r.name).toBe('curl');
    expect(r.wrappedBy).toEqual(['env']);
  });
  it('peels nested wrappers sudo env', () => {
    const r = unwrapArgv(['sudo', 'env', 'X=1', 'rm', '-rf', '~']);
    expect(r.name).toBe('rm');
    expect(r.wrappedBy).toEqual(['sudo', 'env']);
  });
  it('skips an operand-bearing option so the hard-floor command is not hidden behind it', () => {
    // `sudo -u root rm -rf /`: -u takes an operand (the user `root`); without skipping it the peeler
    // roots at `root`, the hard floor (`name==='rm'`) never fires, and YOLO would allow a recursive
    // root wipe. The operand-arity table skips `-u root` and roots at the real `rm`.
    const r = unwrapArgv(['sudo', '-u', 'root', 'rm', '-rf', '/']);
    expect(r.name).toBe('rm');
    expect(r.argv).toEqual(['rm', '-rf', '/']);
    expect(r.wrappedBy).toEqual(['sudo']);
  });
  it('skips short and long operand options (sudo -C N, sudo --preserve-env=X)', () => {
    expect(unwrapArgv(['sudo', '-C', '3', 'rm', '-rf', '/']).name).toBe('rm');
    expect(unwrapArgv(['sudo', '--preserve-env=X', 'rm', '-rf', '/']).name).toBe('rm');
  });
  it('does NOT swallow the inner command after a BOOLEAN flag (sudo -k rm)', () => {
    // -k is not an operand option; treating it as one would eat `rm` and root at `-rf`. The secure
    // default keeps common boolean flags from hiding the real command.
    expect(unwrapArgv(['sudo', '-k', 'rm', '-rf', '/']).name).toBe('rm');
  });
  it('skips env -u NAME (operand) to reach the real egress command', () => {
    const r = unwrapArgv(['env', '-u', 'PATH', 'curl', 'http://evil']);
    expect(r.name).toBe('curl');
    expect(r.wrappedBy).toEqual(['env']);
  });
  it('skips a leading positional operand so `timeout 5 rm` roots at rm', () => {
    // `5` is timeout's mandatory DURATION positional, not the command; without consuming it the
    // peeler roots at `5` and the hard floor misses the rm.
    const r = unwrapArgv(['timeout', '5', 'rm', '-rf', '/']);
    expect(r.name).toBe('rm');
    expect(r.argv).toEqual(['rm', '-rf', '/']);
  });
  it('does NOT peel xargs (stdin operands are not modeled) — stays an unknown root', () => {
    const r = unwrapArgv(['xargs', 'rm', '-rf']);
    expect(r.name).toBe('xargs');
    expect(r.wrappedBy).toEqual([]);
    expect(r.opaque).toBe(false);
  });
  it('peels the exec/command/builtin shell builtins to the inner command', () => {
    expect(unwrapArgv(['exec', 'curl', 'http://evil']).name).toBe('curl');
    expect(unwrapArgv(['command', 'rm', '-rf', '/']).name).toBe('rm');
    expect(unwrapArgv(['builtin', 'cd', '/tmp']).name).toBe('cd');
  });
  it('normalises a quoted/escaped command name so it cannot evade name matching', () => {
    expect(unwrapArgv(['"curl"', 'http://evil']).name).toBe('curl');
    expect(unwrapArgv(['\\curl', 'http://evil']).name).toBe('curl');
    expect(unwrapArgv(['sudo', "'rm'", '-rf', '/']).name).toBe('rm');
  });
});

describe('unwrapArgv — opaque spawners force ask, never strip-and-trust', () => {
  it('marks sh -c opaque and stops', () => {
    const r = unwrapArgv(['sh', '-c', 'rm -rf ~']);
    expect(r.opaque).toBe(true);
    expect(r.name).toBe('sh');
  });
  it('marks eval opaque', () => {
    const r = unwrapArgv(['eval', 'rm -rf ~']);
    expect(r.opaque).toBe(true);
  });
  it('marks source/. opaque', () => {
    expect(unwrapArgv(['source', './evil.sh']).opaque).toBe(true);
    expect(unwrapArgv(['.', './evil.sh']).opaque).toBe(true);
  });
  it('does NOT mark a plain command opaque', () => {
    const r = unwrapArgv(['ffmpeg', '-i', 'a.mp4', 'out.mp4']);
    expect(r.opaque).toBe(false);
    expect(r.name).toBe('ffmpeg');
  });
});

describe('isQualifiedPath — basename grants do not bind to explicit paths', () => {
  it('flags absolute and relative command paths', () => {
    expect(isQualifiedPath('/tmp/evil/ffmpeg')).toBe(true);
    expect(isQualifiedPath('./ffmpeg')).toBe(true);
    expect(isQualifiedPath('"/usr/bin/curl"')).toBe(true); // normalized past the quotes
  });
  it('does NOT flag a bare (PATH-resolved) command name', () => {
    expect(isQualifiedPath('ffmpeg')).toBe(false);
    expect(isQualifiedPath('\\curl')).toBe(false); // escape stripped, no separator
  });
});
