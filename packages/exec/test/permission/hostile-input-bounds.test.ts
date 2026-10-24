import { describe, it, expect, beforeAll } from 'vitest';
import type { CommandRoot, ParsedCommand } from '@minitui/types';
import { checkHardFloor } from '../../src/permission/hard-floor.js';
import { hasGlobOrBrace } from '../../src/permission/shell/names.js';
import { hasBraceExpansion, textIsUnresolved } from '../../src/permission/shell/operands.js';
import { ensureParserReady } from '../../src/permission/shell/parser.js';
import { storeDir } from '../../src/permission/secret-paths.js';

beforeAll(async () => {
  await ensureParserReady();
});

// Work done on shaped text (an operand, a file name, a path) must be bounded by the length of the text,
// not by how it is arranged. Each row hands a sink about a hundred times the realistic size and a bound
// of 100 ms; the old forms took seconds. The inputs are over the 4,096-character command budget of the
// engine, so each row calls the sink on a hand-built value. Only `Date` is frozen in tests, so the clock
// is `performance.now`.
const alice = { home: '/home/alice', platform: 'linux', store: storeDir({}, '/home/alice') };

const parsedOf = (root: CommandRoot): ParsedCommand => ({
  raw: 'x',
  roots: [root],
  hasSubstitution: false,
  parseError: false,
});

// The fastest of three runs. Contention and a cold first call can only slow a run, never speed it up, so
// the minimum is the cost of the work itself; a sink that is super-linear is slow on every run.
const timed = <T>(run: () => T): { readonly ms: number; readonly value: T } => {
  const start = performance.now();
  const value = run();
  let best = performance.now() - start;
  for (let i = 1; i < 3; i++) {
    const again = performance.now();
    run();
    best = Math.min(best, performance.now() - again);
  }
  return { ms: best, value };
};

describe('the store-directory check is linear in the token', () => {
  it('decides a token of 4,000 anchored groups in under 100 ms', () => {
    const parsed = parsedOf({ name: 'cat', argv: ['cat', 'a=~/'.repeat(4000)] });
    checkHardFloor(parsedOf({ name: 'ls', argv: ['ls'] }), [], alice);
    const { ms, value } = timed(() => checkHardFloor(parsed, [], alice));
    expect(ms).toBeLessThan(100);
    // past the cap on anchored tails the token is treated as naming the store: the answer errs to the deny
    expect(value.blocked).toBe(true);
  });
  it('decides a token of 8,000 unanchored groups in under 100 ms and leaves it allowed', () => {
    const parsed = parsedOf({ name: 'cat', argv: ['cat', 'x='.repeat(8000)] });
    const { ms, value } = timed(() => checkHardFloor(parsed, [], alice));
    expect(ms).toBeLessThan(100);
    expect(value.blocked).toBe(false);
  });
});

describe('the cap on anchored tails of the store-directory check', () => {
  // `a=~/x` repeated: each group is one anchored tail that does not name the store
  const groups = (count: number): string => 'a=~/x'.repeat(count);
  const blocked = (token: string): boolean =>
    checkHardFloor(parsedOf({ name: 'cat', argv: ['cat', token] }), [], alice).blocked;
  it('lets a token with 64 anchored tails that name nothing protected through', () => {
    expect(blocked(groups(64))).toBe(false);
  });
  it('denies a token with 65 anchored tails, because the work past 64 is not done', () => {
    expect(blocked(groups(65))).toBe(true);
  });
  it('still denies a token whose tail names the store, however few tails it has', () => {
    expect(blocked('a=~/.local/share/minitui/grants.json')).toBe(true);
  });
});

describe('the later tokens of an opaque argument runner are judged once each', () => {
  // The first token that makes a later candidate unsafe decides the reason, in the order egress,
  // device path, delete, secret.
  const reasonOf = (...tokens: string[]): string | undefined =>
    checkHardFloor(
      parsedOf({ name: 'env', argv: ['env', '--frob', ...tokens], opaque: true }),
      [],
      alice,
    ).reason;
  it('names the earliest unsafe candidate', () => {
    expect(reasonOf('ls', 'curl', 'x')).toBe('network egress via curl is never permitted');
    expect(reasonOf('ls', 'cat', '~/.ssh/config')).toBe(
      'touching a secret file is never permitted',
    );
    expect(reasonOf('rm', '-rf', '/')).toBe('recursive delete of home or root is never permitted');
  });
  it('reads a stdin-fed runner followed by an egress binary as egress', () => {
    expect(reasonOf('xargs', '-n1', 'curl')).toBe('network egress via curl is never permitted');
  });
  it('lets harmless later tokens through', () => {
    expect(reasonOf('ls', '-la', 'build')).toBeUndefined();
  });

  it('decides a runner followed by 2,000 path tokens in under 100 ms', () => {
    const parsed = parsedOf({
      name: 'env',
      argv: ['env', '--frob', ...Array.from({ length: 2000 }, () => '~/x')],
      opaque: true,
    });
    checkHardFloor(parsedOf({ name: 'ls', argv: ['ls'] }), [], alice);
    const { ms, value } = timed(() => checkHardFloor(parsed, [], alice));
    expect(ms).toBeLessThan(100);
    expect(value.blocked).toBe(false);
  });
});

describe('the brace-expansion test is linear in a run of commas', () => {
  const open = '{' + ','.repeat(80_000); // no closing brace: not an expansion, and the old test took seconds
  it('textIsUnresolved decides it in under 100 ms', () => {
    textIsUnresolved('a');
    const { ms, value } = timed(() => textIsUnresolved(open));
    expect(ms).toBeLessThan(100);
    expect(value).toBe(false);
  });
  it('hasGlobOrBrace decides it in under 100 ms', () => {
    hasGlobOrBrace('a');
    const { ms, value } = timed(() => hasGlobOrBrace(open));
    expect(ms).toBeLessThan(100);
    expect(value).toBe(false);
  });
});

describe('the brace-expansion scan agrees with the form it replaced', () => {
  it.each([
    ['{a,b}', true],
    ['{1..3}', true],
    ['x{..}', true],
    ['{{a,b}', true],
    ['{a,b}}', true],
    ['{}', false],
    ['{a}', false],
    ['{a,b', false],
    ['a,b}', false],
    ['{a,{b}', false],
    ['{.}', false],
    ['{a.b}', false],
    ['', false],
  ] as const)('reads %j as %s', (text, expected) => {
    expect(hasBraceExpansion(text)).toBe(expected);
  });
});
