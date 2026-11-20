import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleaner } from '../../src/model-route.js';
import { evalMain } from '../../eval/main.js';
import { anthropicEntry } from '../../eval/providers/anthropic.js';
import type { ProviderEntry } from '../../eval/providers/index.js';
import {
  MODEL,
  RUN_ID,
  committedCase,
  committedReference,
  priceTextFor,
  rowsIn,
  tempDirs,
  testDeps,
  writeCaseSet,
} from '../support/eval-run.js';

const dirs = tempDirs();
afterAll(() => dirs.cleanup());

const SHA = 'a1'.repeat(20);
const KEY_VARIABLE = 'EVAL_TEST_KEY';
const PAID_ENV = { MINITUI_EVAL_PAID: '1', [KEY_VARIABLE]: 'test-key-0123456789' };
const REPLY = committedReference('reply-static-text.jsonl');

// A provider entry whose `live` counts its calls. With the key set it answers over the replaying fetch,
// so a paid run in a test reaches no network.
function countingEntry(): { readonly entry: ProviderEntry; readonly liveCalls: () => number } {
  let calls = 0;
  const entry: ProviderEntry = {
    id: 'counting',
    keyVariable: KEY_VARIABLE,
    live: (env) => {
      calls += 1;
      const key = env[KEY_VARIABLE];
      if (key === undefined || key === '') return undefined;
      const access = anthropicEntry.replay(key);
      return {
        ...access,
        route: (args) =>
          access.route({
            ...args,
            replies: Array.from({ length: 6 }, () => ({
              text: REPLY,
              modelId: MODEL,
              usage: { inputTokens: 1, outputTokens: 1 },
            })),
          }),
      };
    },
    replay: (key) => anthropicEntry.replay(key),
  };
  return { entry, liveCalls: () => calls };
}

function caseFile(): { readonly path: string; readonly out: string } {
  const dir = dirs.make();
  return { path: writeCaseSet(dir, [committedCase('merge-hand-run')]), out: join(dir, 'out') };
}

// The flags of a paid run with every condition met, as name and value pairs, so a row can drop one.
const PAID_FLAGS: ReadonlyArray<readonly [string, string | null]> = [
  ['--arms', 'high'],
  ['--trials', '1'],
  ['--paid', null],
  ['--provider', 'counting'],
  ['--model', MODEL],
  ['--cap-usd', '5'],
  ['--commit', SHA],
];

function argsOf(
  flags: ReadonlyArray<readonly [string, string | null]>,
  over: { readonly drop?: readonly string[]; readonly set?: Readonly<Record<string, string>> } = {},
): string[] {
  const kept = flags.filter(([name]) => !(over.drop ?? []).includes(name));
  const set = Object.entries(over.set ?? {});
  return [
    ...kept.flatMap(([name, value]) =>
      set.some(([n]) => n === name) ? [] : value === null ? [name] : [name, value],
    ),
    ...set.flat(),
  ];
}

async function paid(
  over: Parameters<typeof argsOf>[1] & {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly priceDate?: string;
  } = {},
) {
  const { path, out } = caseFile();
  const counting = countingEntry();
  const {
    deps,
    out: printed,
    err,
  } = testDeps({
    env: over.env ?? PAID_ENV,
    providers: { counting: counting.entry },
    priceText: () => priceTextFor('counting', over.priceDate),
  });
  const code = await evalMain(['--cases', path, '--out', out, ...argsOf(PAID_FLAGS, over)], deps);
  return { code, liveCalls: counting.liveCalls(), printed, err, out };
}

describe('the opt-in gate of the paid lane', () => {
  const without = (name: string) =>
    Object.fromEntries(Object.entries(PAID_ENV).filter(([n]) => n !== name));

  it.each([
    ['MINITUI_EVAL_PAID unset', { env: without('MINITUI_EVAL_PAID') }, /MINITUI_EVAL_PAID=1/],
    [
      'MINITUI_EVAL_PAID=true',
      { env: { ...PAID_ENV, MINITUI_EVAL_PAID: 'true' } },
      /MINITUI_EVAL_PAID=1/,
    ],
    ['CI set', { env: { ...PAID_ENV, CI: 'true' } }, /CI empty or absent/],
    ['CI=1', { env: { ...PAID_ENV, CI: '1' } }, /CI empty or absent/],
    ['no --cap-usd', { drop: ['--cap-usd'] }, /--cap-usd above 0/],
    ['--cap-usd 0', { set: { '--cap-usd': '0' } }, /--cap-usd above 0/],
    ['no --commit', { drop: ['--commit'] }, /--commit <sha>/],
    ['no --paid', { drop: ['--paid'] }, /choose exactly one lane/],
  ] as const)(
    '%s: exit 2 naming it, and no provider entry is called',
    async (_what, over, named) => {
      const result = await paid(over);
      expect(result.code).toBe(2);
      expect(result.liveCalls).toBe(0);
      expect(result.err.join('\n')).toMatch(named);
      expect(existsSync(result.out)).toBe(false);
    },
  );

  it('every condition missing at once is named at once', async () => {
    const result = await paid({ env: {}, drop: ['--cap-usd', '--commit'] });
    expect(result.code).toBe(2);
    expect(result.err[0]).toBe(
      'model-eval: a paid run needs MINITUI_EVAL_PAID=1, --cap-usd above 0, --commit <sha>',
    );
  });

  it('the control: every condition met (CI empty) calls live exactly once, prints the usable budget first, and runs', async () => {
    const result = await paid({ env: { ...PAID_ENV, CI: '' } });
    expect([result.code, result.liveCalls]).toEqual([0, 1]);
    // $5 less one worst case of a 65,536-byte request: 65,536 bytes at $4 and 64,000 output tokens at $10
    expect(result.printed[1]).toBe(
      'usable budget $4.0979: the cap $5.0000 less one worst case of $0.9021 per slot',
    );
    expect(result.printed[2]).toMatch(/^1\/1 merge-hand-run effort-high trial 1: valid/);
    const [row] = rowsIn(join(result.out, RUN_ID));
    expect(row).toMatchObject({
      lane: 'live',
      provider: 'counting',
      requestedModel: MODEL,
      gitCommit: SHA,
      priceTable: { date: '2026-11-20', key: `counting:${MODEL}` },
    });
  });

  it('the replay lane never calls live, and runs under CI with no opt-in', async () => {
    const { path, out } = caseFile();
    const counting = countingEntry();
    const { deps } = testDeps({
      env: { CI: 'true' },
      providers: { counting: counting.entry },
      priceText: () => priceTextFor('counting'),
    });
    const args = ['--cases', path, '--out', out, '--arms', 'high', '--trials', '1'];
    expect(
      await evalMain([...args, '--replay', '--provider', 'counting', '--model', MODEL], deps),
    ).toBe(0);
    expect(counting.liveCalls()).toBe(0);
  });

  it('the dry lane runs under CI', async () => {
    const { path, out } = caseFile();
    const { deps } = testDeps({ env: { CI: 'true' } });
    const args = ['--cases', path, '--out', out, '--arms', 'high', '--trials', '1', '--dry-run'];
    expect(await evalMain(args, deps)).toBe(0);
  });
});

describe('the key', () => {
  it.each([
    ['missing', { MINITUI_EVAL_PAID: '1' }],
    ['empty', { MINITUI_EVAL_PAID: '1', [KEY_VARIABLE]: '' }],
  ])('%s: exit 1 naming the provider’s variable, before any trial', async (_what, env) => {
    const result = await paid({ env });
    expect([result.code, result.liveCalls]).toEqual([1, 1]);
    expect(result.err).toEqual([`model-eval: ${KEY_VARIABLE} is not set`]);
    expect(result.printed).toEqual([]);
    expect(existsSync(result.out)).toBe(false);
  });

  it('the real entry names its own variable', async () => {
    const { path, out } = caseFile();
    const { deps, err } = testDeps({ env: { MINITUI_EVAL_PAID: '1' } });
    const flags = argsOf(PAID_FLAGS, { set: { '--provider': 'anthropic' } });
    expect(await evalMain(['--cases', path, '--out', out, ...flags], deps)).toBe(1);
    expect(err).toEqual([`model-eval: ${anthropicEntry.keyVariable} is not set`]);
  });
});

describe('a provider entry whose live throws', () => {
  const PLANTED = 'Zq-planted-live-key.0123456789abcdef';
  const failure = `could not open a route for ${PLANTED}`;

  it('exit 1 with a fixed message naming the provider, never the error’s text', async () => {
    const { path, out } = caseFile();
    const throwing: ProviderEntry = {
      id: 'throwing',
      keyVariable: KEY_VARIABLE,
      live: () => {
        throw new Error(failure);
      },
      replay: (key) => anthropicEntry.replay(key),
    };
    const {
      deps,
      out: printed,
      err,
    } = testDeps({
      env: PAID_ENV,
      providers: { throwing },
      priceText: () => priceTextFor('throwing'),
    });
    const flags = argsOf(PAID_FLAGS, { set: { '--provider': 'throwing' } });
    expect(await evalMain(['--cases', path, '--out', out, ...flags], deps)).toBe(1);
    expect(err).toEqual([
      'model-eval: the provider "throwing" failed while opening its live route',
    ]);
    expect([...printed, ...err].filter((line) => line.includes(PLANTED))).toEqual([]);
    expect(existsSync(out)).toBe(false);
  });

  it('the control: printed through the placeholder’s cleaner, the error’s own text would show the key', () => {
    expect(cleaner('minitui-placeholder-key').message(new Error(failure))).toContain(PLANTED);
  });
});

describe('the cap floor, the price table and the provider', () => {
  // the floor is twice $0.902144 per slot
  it.each([
    ['1.80', '1', '$1.8043'],
    ['3.60', '2', '$3.6086'],
  ])('--cap-usd %s at concurrency %s: exit 2 naming the floor %s', async (cap, slots, floor) => {
    const result = await paid({ set: { '--cap-usd': cap, '--concurrency': slots } });
    expect([result.code, result.liveCalls]).toEqual([2, 0]);
    expect(result.err[0]).toContain(`below the floor of ${floor}`);
  });

  it.each([
    ['1.81', '1'],
    ['3.61', '2'],
  ])('the control: --cap-usd %s at concurrency %s reaches the key', async (cap, slots) => {
    const result = await paid({
      env: { MINITUI_EVAL_PAID: '1' },
      set: { '--cap-usd': cap, '--concurrency': slots },
    });
    expect([result.code, result.liveCalls]).toEqual([1, 1]);
  });

  it('a table read more than 30 days before the run: exit 2 with the reason', async () => {
    const result = await paid({ priceDate: '2026-10-20' });
    expect([result.code, result.liveCalls]).toEqual([2, 0]);
    expect(result.err[0]).toBe('model-eval: price table: date 2026-10-20 is more than 30 days ago');
  });

  it('the control: a table 30 days old reaches the key', async () => {
    const result = await paid({ priceDate: '2026-10-21', env: { MINITUI_EVAL_PAID: '1' } });
    expect([result.code, result.liveCalls]).toEqual([1, 1]);
  });

  it('a table with no entry for the model: exit 2', async () => {
    const result = await paid({ set: { '--model': 'other-model' } });
    expect([result.code, result.liveCalls]).toEqual([2, 0]);
    expect(result.err[0]).toBe('model-eval: price table: no entry for counting:other-model');
  });

  it('an unknown provider: exit 2 naming the known ones', async () => {
    const result = await paid({ set: { '--provider': 'nope' } });
    expect([result.code, result.liveCalls]).toEqual([2, 0]);
    expect(result.err[0]).toBe('model-eval: no provider "nope"; known: counting');
  });
});

describe('the flags', () => {
  it.each([
    ['120', 'a trial timeout of 120'],
    ['2147484', 'a timer past 2^31 - 1 ms'],
    ['0', 'zero'],
    ['9e2', 'a number that is not written whole'],
  ])('--trial-timeout-s %s (%s): exit 2', async (value) => {
    const result = await paid({ set: { '--trial-timeout-s': value } });
    expect([result.code, result.liveCalls]).toEqual([2, 0]);
    expect(result.err[0]).toBe(
      'model-eval: --trial-timeout-s must be a whole number from 121 to 2147483',
    );
  });

  it.each(['121', '2147483'])(
    'the control: --trial-timeout-s %s reaches the key',
    async (value) => {
      const result = await paid({
        env: { MINITUI_EVAL_PAID: '1' },
        set: { '--trial-timeout-s': value },
      });
      expect([result.code, result.liveCalls]).toEqual([1, 1]);
    },
  );

  it.each([
    ['an unknown flag', { set: { '--bogus': 'x' } }, /Unknown option '--bogus'/],
    ['no --cases', { drop: ['--cases'] }, /--cases is required/],
    ['no --arms', { drop: ['--arms'] }, /--arms is required/],
    ['an arm that is no effort', { set: { '--arms': 'none' } }, /"none" is not one/],
    ['an arm twice', { set: { '--arms': 'high,high' } }, /names an effort twice/],
    ['no --trials', { drop: ['--trials'] }, /--trials is required/],
    ['zero trials', { set: { '--trials': '0' } }, /--trials must be a whole number from 1/],
    [
      'concurrency 0',
      { set: { '--concurrency': '0' } },
      /--concurrency must be a whole number from 1 to 4/,
    ],
    [
      'concurrency 5',
      { set: { '--concurrency': '5' } },
      /--concurrency must be a whole number from 1 to 4/,
    ],
    [
      'a suite that is neither',
      { set: { '--suite': 'other' } },
      /--suite is regression or capability/,
    ],
    ['a commit that is no sha', { set: { '--commit': 'abc123' } }, /40-character hex sha/],
    ['a cap that is no number', { set: { '--cap-usd': 'five' } }, /--cap-usd must be a number/],
    ['no --model', { drop: ['--model'] }, /--model is required/],
    ['two lanes', { set: { '--replay': '' } }, /choose exactly one lane/],
  ] as const)('%s: exit 2 with the usage', async (_what, over, message) => {
    const { path, out } = caseFile();
    const counting = countingEntry();
    const { deps, err } = testDeps({ env: PAID_ENV, providers: { counting: counting.entry } });
    const flags = [['--cases', path] as const, ...PAID_FLAGS];
    const args = argsOf(flags, over).filter((arg) => arg !== '');
    expect(await evalMain(['--out', out, ...args], deps)).toBe(2);
    expect(counting.liveCalls()).toBe(0);
    expect(err[0]).toMatch(message);
    expect(err.some((line) => line.startsWith('usage: model-eval'))).toBe(true);
  });

  it('the control: --concurrency 4 and --trials 2 reach the key', async () => {
    const result = await paid({
      env: { MINITUI_EVAL_PAID: '1' },
      set: { '--concurrency': '4', '--trials': '2', '--cap-usd': '8' },
    });
    expect([result.code, result.liveCalls]).toEqual([1, 1]);
  });

  it('one leading -- is dropped (pnpm forwards it); a second one ends the flags and is refused', async () => {
    const { path, out } = caseFile();
    const counting = countingEntry();
    const { deps } = testDeps({
      env: { MINITUI_EVAL_PAID: '1' },
      providers: { counting: counting.entry },
      priceText: () => priceTextFor('counting'),
    });
    const args = ['--cases', path, '--out', out, ...argsOf(PAID_FLAGS)];
    expect(await evalMain(['--', ...args], deps)).toBe(1);
    expect(await evalMain(['--', '--', ...args], deps)).toBe(2);
    expect(counting.liveCalls()).toBe(1);
  });

  it('the dry lane takes no provider, model or cap', async () => {
    const { path, out } = caseFile();
    const { deps, err } = testDeps();
    const args = ['--cases', path, '--out', out, '--arms', 'high', '--trials', '1', '--dry-run'];
    expect(await evalMain([...args, '--model', MODEL], deps)).toBe(2);
    expect(err[0]).toBe('model-eval: --provider, --model and --cap-usd are not for --dry-run');
  });
});

describe('the case set and its selection', () => {
  const dry = (path: string, out: string, ...rest: string[]) => [
    '--cases',
    path,
    '--out',
    out,
    '--arms',
    'high',
    '--trials',
    '1',
    '--dry-run',
    ...rest,
  ];

  it.each([
    [
      '--only naming no case',
      ['--only', 'merge-hand-run,no-such-case'],
      /--only names no case no-such-case/,
    ],
    ['a selection of nothing', ['--suite', 'capability'], /no case is selected/],
  ])('%s: exit 2, and no run directory', async (_what, rest, message) => {
    const { path, out } = caseFile();
    const { deps, err } = testDeps();
    expect(await evalMain(dry(path, out, ...rest), deps)).toBe(2);
    expect(err[0]).toMatch(message);
    expect(existsSync(out)).toBe(false);
  });

  it('a case file that does not load: exit 2', async () => {
    const dir = dirs.make();
    const path = join(dir, 'cases.jsonl');
    writeFileSync(path, '{"status":"draft","caseSetVersion":1}\n{"id":"Bad Id"}\n');
    const { deps, err } = testDeps();
    expect(await evalMain(dry(path, join(dir, 'out')), deps)).toBe(2);
    expect(err[0]).toMatch(/^model-eval: the case set: case 1: /);
  });

  it('a second run with the same id is refused rather than appended to', async () => {
    const { path, out } = caseFile();
    expect(await evalMain(dry(path, out), testDeps().deps)).toBe(0);
    const { deps, err } = testDeps();
    expect(await evalMain(dry(path, out), deps)).toBe(1);
    expect(err[0]).toMatch(/EEXIST/);
    expect(rowsIn(join(out, RUN_ID))).toHaveLength(1);
  });
});
