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

// The fastest of nine runs, in milliseconds. Contention and a cold first call can only slow a run, never
// speed it up, so the minimum is the cost of the work itself; a sink that is super-linear is slow on every
// run.
const fastest = (run: () => unknown, runs = 9): number => {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
};

const timed = <T>(run: () => T): { readonly ms: number; readonly value: T } => {
  const value = run();
  return { ms: fastest(run, 3), value };
};

// How the cost of a sink grows with its input: the fastest run at the full size over the fastest run at
// 1/shrink of it. Linear work grows about `shrink` times and quadratic work about `shrink` squared. A busy
// machine does not slow both sizes alike: it stretches a long run more than a short one, and the ratio of two
// plain minimums at a shrink of 8 read above 24 for linear work in 9 of 25 runs of this file beside 32 busy
// loops. So the smaller size is timed as a batch of `shrink` runs, which makes both samples about as long;
// the ratio is the least of three such measurements, so that one misread does not decide the row; and the
// shrink is 16 with a bound of 64, four times the linear reading, which a quadratic sink at about 256 is far
// over. Linear work read at most 19.8 in 144 cold readings of the two rows, quiet and beside 32 and 64 busy
// loops. A timer cannot tell below 0.2 ms, so the smaller time is floored there.
const growth = (build: (size: number) => () => unknown, full: number, shrink: number): number => {
  const big = build(full);
  const small = build(full / shrink);
  const batch = (): void => {
    for (let k = 0; k < shrink; k++) small();
  };
  let least = Infinity;
  for (let attempt = 0; attempt < 3; attempt++) {
    least = Math.min(least, fastest(big) / Math.max(fastest(batch) / shrink, 0.2));
  }
  return least;
};

describe('the store-directory check is linear in the token', () => {
  // 4,000 anchored groups is 16,000 characters; the split-and-join form took 584 ms and grows with the
  // square of the groups. The cost must grow at most about linearly: sixteenfold for sixteenfold more
  // groups, and the bound allows four times that.
  const storeToken = (groups: number): (() => unknown) => {
    const parsed = parsedOf({ name: 'cat', argv: ['cat', 'a=~/'.repeat(groups)] });
    return () => checkHardFloor(parsed, [], alice);
  };
  it('grows at most about linearly with the number of anchored groups', () => {
    checkHardFloor(parsedOf({ name: 'ls', argv: ['ls'] }), [], alice);
    expect(growth(storeToken, 4000, 16)).toBeLessThan(64);
  });
  it('past the cap on anchored tails the token is treated as naming the store: the answer errs to the deny', () => {
    expect(storeToken(4000)()).toMatchObject({ blocked: true });
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

  // A candidate root and a floor rerun per token took 3.3 s for 2,000 tokens and grows with the square of
  // them; each token is now judged once.
  const laterTokens = (count: number): (() => unknown) => {
    const parsed = parsedOf({
      name: 'env',
      argv: ['env', '--frob', ...Array.from({ length: count }, () => '~/x')],
      opaque: true,
    });
    return () => checkHardFloor(parsed, [], alice);
  };
  it('grows at most about linearly with the number of later tokens', () => {
    checkHardFloor(parsedOf({ name: 'ls', argv: ['ls'] }), [], alice);
    expect(growth(laterTokens, 2000, 16)).toBeLessThan(64);
  });
  it('lets 2,000 harmless later tokens through', () => {
    expect(laterTokens(2000)()).toMatchObject({ blocked: false });
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
