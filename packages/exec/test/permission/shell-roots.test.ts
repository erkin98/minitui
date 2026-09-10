import { describe, it, expect, beforeAll } from 'vitest';
import { ensureParserReady } from '../../src/permission/shell/parser.js';
import { parseShellCommand } from '../../src/permission/shell/roots.js';
import { OPAQUE_SPAWNERS } from '../../src/permission/shell/wrappers.js';

beforeAll(async () => {
  await ensureParserReady();
});

describe('parseShellCommand', () => {
  it('extracts a single root', () => {
    const p = parseShellCommand('ls -la');
    expect(p.parseError).toBe(false);
    expect(p.roots.map((r) => r.name)).toEqual(['ls']);
  });
  it('splits && into two roots', () => {
    const p = parseShellCommand('ls && rm -rf /');
    expect(p.roots.map((r) => r.name)).toEqual(['ls', 'rm']);
  });
  it('splits a pipe', () => {
    const p = parseShellCommand('echo hi | rm -rf ~');
    expect(p.roots.map((r) => r.name)).toEqual(['echo', 'rm']);
  });
  it('splits newline-separated commands', () => {
    const p = parseShellCommand('ls\nrm -rf ~');
    expect(p.roots.map((r) => r.name)).toEqual(['ls', 'rm']);
  });
  it('unwraps sudo so the gated root is rm not sudo', () => {
    const p = parseShellCommand('sudo rm -rf /');
    expect(p.roots[0]!.name).toBe('rm');
    expect(p.roots[0]!.argv).toEqual(['rm', '-rf', '/']);
  });
  it('resolves env KEY=VALUE wrapping to the inner gated root (the real AST seam)', () => {
    // `env` is the command_name; `X=1` is an argument WORD (a variable_assignment node only forms
    // for a LEADING `X=1 cmd`). argvOf yields ['env','X=1','curl',...] so unwrapArgv's env
    // KEY=VALUE skip peels env to the real curl.
    const p = parseShellCommand('env X=1 curl http://evil');
    expect(p.roots[0]!.name).toBe('curl');
    expect(p.roots[0]!.argv).toEqual(['curl', 'http://evil']);
  });
  it('drops a bare assignment-prefix so the REAL command is the gated root (not FOO=bar)', () => {
    // `FOO=bar curl` emits a LEADING variable_assignment before command_name; argvOf drops it,
    // so the gated root is curl (which egress/hard-floor then catch) — not `FOO=bar`.
    const p = parseShellCommand('FOO=bar curl http://evil');
    expect(p.roots[0]!.name).toBe('curl');
    expect(p.roots[0]!.argv).toEqual(['curl', 'http://evil']);
  });
  it('threads a redirect target onto the gated root argv so a `> secret` write is visible', () => {
    // the file_redirect lives on a redirected_statement sibling; its target must reach the argv
    // so the hard-floor can see the secret-file write target.
    const p = parseShellCommand('echo x > ~/.ssh/authorized_keys');
    expect(p.roots[0]!.name).toBe('echo');
    expect(p.roots[0]!.argv).toContain('~/.ssh/authorized_keys');
  });
  it('sets hasSubstitution on $()', () => {
    const p = parseShellCommand('ffmpeg -i $(echo a).mp4 out.mp4');
    expect(p.hasSubstitution).toBe(true);
  });
  it('keeps the opaque spawner as the gated root name (decision.ts re-derives opaque)', () => {
    const p = parseShellCommand('sh -c "rm -rf ~"');
    expect(p.roots[0]!.name).toBe('sh');
    expect(OPAQUE_SPAWNERS.has(p.roots[0]!.name)).toBe(true);
  });
  it('roots carry ONLY the canonical {name, argv} wire shape (no wrappedBy/opaque)', () => {
    const p = parseShellCommand('sudo rm -rf /');
    expect(Object.keys(p.roots[0]!).sort()).toEqual(['argv', 'name']);
  });
  it('returns parseError, never throws, on broken syntax', () => {
    const p = parseShellCommand('ls "unterminated');
    expect(p.parseError).toBe(true);
    expect(p.roots).toEqual([]);
  });
  it('fail-closed on an unmodeled subshell — no partial root is extracted', () => {
    // `(...)` is a subshell node outside the modeled set; minitui does not model subshell
    // semantics, so it degrades to parseError instead of silently peeling the inner rm.
    const p = parseShellCommand('(rm -rf /)');
    expect(p.parseError).toBe(true);
    expect(p.roots).toEqual([]);
  });
  it('fail-closed on arithmetic / brace-group / control-flow / function nodes', () => {
    expect(parseShellCommand('echo $((1+1))').parseError).toBe(true);
    expect(parseShellCommand('{ rm -rf /; }').parseError).toBe(true);
    expect(parseShellCommand('if true; then rm x; fi').parseError).toBe(true);
    expect(parseShellCommand('for f in *; do rm $f; done').parseError).toBe(true);
    expect(parseShellCommand('foo() { rm x; }').parseError).toBe(true);
  });
  it('KEEPS modeled expansions — ${HOME} concatenation still parses to a gated root', () => {
    // minitui allows expansions through precisely so the hard-floor can see them; the positive
    // allowlist must not over-reject the constructs minitui models.
    const p = parseShellCommand('cat ${HOME}/.ssh/id_rsa');
    expect(p.parseError).toBe(false);
    expect(p.roots[0]!.name).toBe('cat');
  });
  it('KEEPS a backgrounded plain command — `rm x &` still gates rm (& is a modeled separator)', () => {
    const p = parseShellCommand('rm x &');
    expect(p.parseError).toBe(false);
    expect(p.roots[0]!.name).toBe('rm');
  });
  it('canonicalizes a quoted/split command name so an evasion still gates as the bare binary', () => {
    expect(parseShellCommand('cu""rl http://evil').roots[0]!.name).toBe('curl');
    expect(parseShellCommand('\\c\\url http://evil').roots[0]!.name).toBe('curl');
  });
  it('emits each peeled wrapper as its OWN root so a managed deny can match the wrapper name', () => {
    const p = parseShellCommand('sudo rm -rf /');
    expect(p.roots[0]!.name).toBe('rm'); // inner (gated) root stays first
    expect(p.roots.map((r) => r.name)).toContain('sudo'); // the wrapper is also a root now
  });
  it('fails closed (deny) on a parameter-expansion command NAME — the binary is unresolvable', () => {
    expect(parseShellCommand('$CC -o out in.c').parseError).toBe(true);
    expect(parseShellCommand('cu${X}rl http://evil').parseError).toBe(true);
  });
  it('models a trailing comment instead of fail-closing on it', () => {
    const p = parseShellCommand('ls -la # list');
    expect(p.parseError).toBe(false);
    expect(p.roots[0]!.name).toBe('ls');
  });
});
