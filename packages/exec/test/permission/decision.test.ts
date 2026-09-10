import { describe, it, expect, beforeAll } from 'vitest';
import { ensureParserReady } from '../../src/permission/shell/parser.js';
import { parseShellCommand } from '../../src/permission/shell/roots.js';
import { resolveStatic } from '../../src/permission/decision.js';
import type { RuleSet } from '../../src/permission/rules.js';

beforeAll(async () => {
  await ensureParserReady();
});

const rules = (r: RuleSet['rules']): RuleSet => ({ rules: r });

describe('resolveStatic — deny-first triad', () => {
  it('allows when every root has an explicit allow', () => {
    const p = parseShellCommand('ffmpeg -i a out');
    expect(resolveStatic(p, rules([{ pattern: 'ffmpeg', effect: 'allow', layer: 'user' }]))).toBe(
      'allow',
    );
  });
  it('asks when a root has no rule', () => {
    const p = parseShellCommand('ffmpeg -i a out');
    expect(resolveStatic(p, rules([]))).toBe('ask');
  });
  it('denies when any root resolves deny, even with a more specific allow', () => {
    const p = parseShellCommand('ls && rm -rf /');
    const r = rules([
      { pattern: 'ls', effect: 'allow', layer: 'user' },
      { pattern: 'rm -rf /', effect: 'allow', layer: 'user' }, // most specific allow
      { pattern: 'rm', effect: 'deny', layer: 'user' }, // deny still wins
    ]);
    expect(resolveStatic(p, r)).toBe('deny');
  });
  it('asks on substitution regardless of allow rules', () => {
    const p = parseShellCommand('ffmpeg -i $(echo a).mp4 out');
    expect(resolveStatic(p, rules([{ pattern: 'ffmpeg', effect: 'allow', layer: 'user' }]))).toBe(
      'ask',
    );
  });
  it('asks on an opaque spawner even with an allow rule for the spawner', () => {
    // opaque is re-derived from the root name (OPAQUE_SPAWNERS.has('sh')); an `sh` allow rule
    // must NOT let `sh -c "..."` through — the quoted payload is unparseable, so force ask.
    const p = parseShellCommand('sh -c "ls"');
    expect(resolveStatic(p, rules([{ pattern: 'sh', effect: 'allow', layer: 'user' }]))).toBe(
      'ask',
    );
  });
  it('asks (never allows) on parseError', () => {
    const p = parseShellCommand('ls "unterminated');
    expect(resolveStatic(p, rules([{ pattern: 'ls', effect: 'allow', layer: 'user' }]))).toBe(
      'ask',
    );
  });
  it('a bare-name allow does NOT auto-approve a path-qualified shadow binary', () => {
    const allowFfmpeg = rules([{ pattern: 'ffmpeg', effect: 'allow', layer: 'user' }]);
    // bare (PATH-resolved) ffmpeg is allowed…
    expect(resolveStatic(parseShellCommand('ffmpeg -i a out'), allowFfmpeg)).toBe('allow');
    // …but an explicit-path invocation of a same-basename binary does NOT inherit the grant -> ask
    expect(resolveStatic(parseShellCommand('/tmp/evil/ffmpeg -i a out'), allowFfmpeg)).toBe('ask');
  });
  it('an explicit-path allow rule DOES cover that exact path (operator opt-in)', () => {
    const r = rules([{ pattern: '/opt/bin/ffmpeg', effect: 'allow', layer: 'user' }]);
    expect(resolveStatic(parseShellCommand('/opt/bin/ffmpeg -i a out'), r)).toBe('allow');
  });
  it('a git allow does NOT cover a -c global-option hijack (downgrades to ask)', () => {
    const allowGit = rules([{ pattern: 'git', effect: 'allow', layer: 'user' }]);
    expect(resolveStatic(parseShellCommand('git log --oneline'), allowGit)).toBe('allow');
    expect(resolveStatic(parseShellCommand('git -c core.pager=touch\\ x log'), allowGit)).toBe(
      'ask',
    );
    expect(resolveStatic(parseShellCommand('git -C /other/repo status'), allowGit)).toBe('ask');
  });
  it('an ffmpeg allow covers a local transcode but NOT a network-URL input (asks)', () => {
    const allowFfmpeg = rules([{ pattern: 'ffmpeg', effect: 'allow', layer: 'user' }]);
    expect(resolveStatic(parseShellCommand('ffmpeg -i a.mp4 -i b.mp4 out.mp4'), allowFfmpeg)).toBe(
      'allow',
    );
    expect(
      resolveStatic(parseShellCommand('ffmpeg -i https://evil/x.mp4 out.mp4'), allowFfmpeg),
    ).toBe('ask');
  });
  it('an identity-bound grant downgrades to ask when the resolved realpath no longer matches', () => {
    // grant `ffmpeg` bound to the realpath it was approved for; resolveExecutable is a REAL injected
    // fake (a plain function, no vi.mock — a real port impl, injected through the production seam).
    const bound = rules([
      { pattern: 'ffmpeg', effect: 'allow', layer: 'user', identity: '/usr/bin/ffmpeg' },
    ]);
    const p = parseShellCommand('ffmpeg -i a out');
    // same identity → the grant still auto-allows (no false-positive on the legit repeat)
    expect(resolveStatic(p, bound, () => '/usr/bin/ffmpeg')).toBe('allow');
    // a mid-session PATH/symlink swap resolves elsewhere → downgrade allow→ask (never deny)
    expect(resolveStatic(p, bound, () => '/tmp/evil/ffmpeg')).toBe('ask');
    // an explicit-path grant whose symlink target was swapped is ALSO caught (the lexical test isn't)
    const boundPath = rules([
      { pattern: '/opt/bin/ffmpeg', effect: 'allow', layer: 'user', identity: '/opt/bin/ffmpeg' },
    ]);
    expect(
      resolveStatic(
        parseShellCommand('/opt/bin/ffmpeg -i a out'),
        boundPath,
        () => '/tmp/evil/ffmpeg',
      ),
    ).toBe('ask');
    // a name-only grant (no identity: operator config / legacy) is unaffected by the resolver
    const nameOnly = rules([{ pattern: 'ffmpeg', effect: 'allow', layer: 'user' }]);
    expect(resolveStatic(p, nameOnly, () => '/tmp/evil/ffmpeg')).toBe('allow');
  });
  it('a stdin-fed runner (xargs) asks even WITH an allow rule — its target is unknowable', () => {
    const p = parseShellCommand('echo x | xargs rm -rf');
    expect(resolveStatic(p, rules([{ pattern: 'xargs', effect: 'allow', layer: 'user' }]))).toBe(
      'ask',
    );
  });
  it('a managed deny on a wrapper name (sudo) fires via the emitted wrapper root', () => {
    const p = parseShellCommand('sudo ffprobe a.mp4');
    const r = rules([
      { pattern: 'ffprobe', effect: 'allow', layer: 'user' },
      { pattern: 'sudo', effect: 'deny', layer: 'managed' },
    ]);
    expect(resolveStatic(p, r)).toBe('deny'); // the emitted sudo wrapper root matches the managed deny
  });
});
