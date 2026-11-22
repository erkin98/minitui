import { describe, it, expect, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Effort } from '@minitui/agent-core';
import { buildCatalogPrompt, videoMergeCatalog } from '@minitui/catalog';
import type { MiniAppSpec } from '@minitui/spec';
import { composeSystemPrompt } from '../../src/generation.js';
import { CASE_DIR, loadCaseSet } from '../../eval/harness/cases.js';
import { EVAL_HARNESS_ID } from '../../eval/harness/row.js';
import { replyFor, rowFor } from '../../eval/harness/run.js';
import { armOrder, schedule } from '../../eval/harness/schedule.js';
import { RunAbort, type StopKind, type TrialObservation } from '../../eval/harness/trial.js';
import { evalMain } from '../../eval/main.js';
import { recordingDiagnostics } from '../support/fakes.js';
import {
  CODECS,
  MODEL,
  RUN_ID,
  answeringReplay,
  committedCase,
  committedReference,
  droppingStepRecord,
  failingReplay,
  filesIn,
  recordingReplay,
  rowsIn,
  tempDirs,
  testDeps,
  writeCaseSet,
} from '../support/eval-run.js';

const dirs = tempDirs();
afterAll(() => dirs.cleanup());

const ESC = String.fromCharCode(0x1b);
const CSI = String.fromCharCode(0x9b);
const HIDDEN = '[redacted-secret]';

const dryArgs = (cases: string, out: string, ...rest: string[]): string[] => [
  '--cases',
  cases,
  '--out',
  out,
  '--dry-run',
  ...rest,
];
const replayArgs = (cases: string, out: string, ...rest: string[]): string[] => [
  '--cases',
  cases,
  '--out',
  out,
  '--replay',
  '--provider',
  'anthropic',
  '--model',
  MODEL,
  ...rest,
];

// A case set in a fresh directory, and the run directory its run will write.
function setup(cases: readonly Record<string, unknown>[], references: Record<string, string> = {}) {
  const dir = dirs.make();
  const path = writeCaseSet(dir, cases, references);
  const out = join(dir, 'out');
  return { dir, path, out, runDir: join(out, RUN_ID) };
}

const ROW_KEYS = [
  'harness',
  'runId',
  'lane',
  'layer',
  'caseId',
  'caseVersion',
  'caseSetVersion',
  'gradingVersion',
  'suite',
  'split',
  'catalog',
  'arm',
  'trial',
  'provider',
  'requestedModel',
  'responseModelIds',
  'effortSent',
  'gitCommit',
  'systemPromptSha256',
  'capabilityFingerprint',
  'priceTable',
  'attempts',
  'stop',
  'spec',
  'checks',
  'passAll',
  'cause',
  'usage',
  'cost',
  'durationMs',
].sort();

describe('a dry run of a three-case set', () => {
  it('writes rows that parse back as rows, the run’s metadata, its diagnostics and a report', async () => {
    const run = setup(['merge-hand-run', 'cap-trim-lecture', 'cap-pick-folder'].map(committedCase));
    const { deps, out } = testDeps();
    const code = await evalMain(
      dryArgs(run.path, run.out, '--arms', 'medium,high', '--trials', '1'),
      deps,
    );
    expect(code).toBe(0);
    expect(filesIn(run.runDir)).toEqual(['diagnostics.log', 'report.md', 'rows.jsonl', 'run.json']);

    const rows = rowsIn(run.runDir);
    expect(rows).toHaveLength(6);
    const fingerprint = createHash('sha256').update(CODECS.toSorted().join('\n')).digest('hex');
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
      expect(row).toMatchObject({
        harness: EVAL_HARNESS_ID,
        runId: RUN_ID,
        lane: 'dry',
        layer: 'generation',
        caseSetVersion: 1,
        gradingVersion: 1,
        provider: 'scripted',
        requestedModel: 'scripted',
        responseModelIds: [],
        gitCommit: null,
        capabilityFingerprint: fingerprint,
        priceTable: null,
        cost: { measuredUsd: 0, upperUsd: 0 },
      });
      expect(row.systemPromptSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.effortSent).toBe(row.arm.slice('effort-'.length));
    }
    const byCase = (id: string) => rows.filter((r) => r.caseId === id);
    expect(byCase('merge-hand-run').map((r) => [r.stop, r.passAll])).toEqual([
      ['valid', true],
      ['valid', true],
    ]);
    expect(byCase('cap-trim-lecture').map((r) => [r.stop, r.attempts.length, r.cause])).toEqual([
      ['exhausted', 6, 'missing-action'],
      ['exhausted', 6, 'missing-action'],
    ]);
    // the reply's paths are the case's own directory, named by its position in the file
    const [hand] = byCase('merge-hand-run');
    expect(JSON.stringify(hand?.spec)).toMatch(/\/c01\/a\.mp4"/);

    const meta: Record<string, unknown> = JSON.parse(
      readFileSync(join(run.runDir, 'run.json'), 'utf8'),
    );
    expect(meta).toMatchObject({
      harness: EVAL_HARNESS_ID,
      runId: RUN_ID,
      lane: 'dry',
      caseSetVersion: 1,
      gradingVersion: 1,
      concurrency: 1,
      trialTimeoutS: 900,
      priceTable: null,
      capabilityFingerprint: fingerprint,
      cases: ['merge-hand-run', 'cap-trim-lecture', 'cap-pick-folder'],
    });
    // each record of the run's one diagnostics file names the trial it came from
    const log = readFileSync(join(run.runDir, 'diagnostics.log'), 'utf8');
    const exhausted = log
      .split('\n')
      .filter((line) => line.includes('could not generate a valid mini app'));
    expect(exhausted.map((line) => JSON.parse(line).meta.trial).sort()).toEqual([
      'cap-trim-lecture/high/1',
      'cap-trim-lecture/medium/1',
    ]);
    const report = readFileSync(join(run.runDir, 'report.md'), 'utf8');
    expect(report).toContain(`# Model-output eval: run ${RUN_ID}`);
    expect(report).toContain('## Failed trials');
    expect(out[0]).toMatch(new RegExp(`^run ${RUN_ID}: dry lane, 3 cases`));
    expect(out.filter((line) => /^\d+\/6 /.test(line))).toHaveLength(6);
    expect(out.at(-1)).toBe(`report: ${join(run.runDir, 'report.md')}`);
  });
});

describe('the arm order', () => {
  // capability cases at file positions 2, 4, 5 and 7, regression cases between them
  const SET = [
    'merge-hand-run',
    'cap-pick-folder',
    'merge-trip-days',
    'cap-coffee-size',
    'cap-tip-calculator',
    'merge-xyz-bare',
    'cap-countdown',
  ];

  it('high runs first exactly when i + t is even, i counted among the selected cases; --suite capability selects only them', async () => {
    const run = setup(SET.map(committedCase));
    // the flag's order is not the run's order
    const code = await evalMain(
      dryArgs(run.path, run.out, '--arms', 'high,medium', '--trials', '2', '--suite', 'capability'),
      testDeps().deps,
    );
    expect(code).toBe(0);
    const capability = [
      'cap-pick-folder',
      'cap-coffee-size',
      'cap-tip-calculator',
      'cap-countdown',
    ];
    const expected = capability.flatMap((id, i) =>
      [1, 2].flatMap((t) =>
        ((i + 1 + t) % 2 === 0 ? ['high', 'medium'] : ['medium', 'high']).map(
          (arm) => `${id} effort-${arm} ${t}`,
        ),
      ),
    );
    const rows = rowsIn(run.runDir);
    expect(rows.map((r) => `${r.caseId} ${r.arm} ${r.trial}`)).toEqual(expected);
    expect(new Set(rows.map((r) => r.suite))).toEqual(new Set(['capability']));
    // each arm runs first in half of the pairs
    const firsts = rows.filter((_, n) => n % 2 === 0).map((r) => r.arm);
    expect(firsts.filter((arm) => arm === 'effort-high')).toHaveLength(4);
  });

  it('the working directory is named by the case’s position in the file, not among the selected', async () => {
    const run = setup(SET.map(committedCase));
    const args = dryArgs(run.path, run.out, '--arms', 'high', '--trials', '1');
    expect(await evalMain([...args, '--only', 'merge-xyz-bare'], testDeps().deps)).toBe(0);
    const [row] = rowsIn(run.runDir);
    expect(JSON.stringify(row?.spec)).toMatch(/\/c06\/x\.mp4"/);
  });

  it('armOrder: one arm alone, and three arms reversed on an even i + t', () => {
    expect(armOrder(['high'], 1, 1)).toEqual(['high']);
    const three: Effort[] = ['max', 'low', 'high'];
    expect(armOrder(three, 1, 1)).toEqual(['max', 'high', 'low']);
    expect(armOrder(three, 1, 2)).toEqual(['low', 'high', 'max']);
  });
});

describe('the replay lane under its cap', () => {
  const TWO = ['merge-hand-run', 'merge-trip-days'].map(committedCase);

  it('a cap below one worst-case request: the first trial ends spend-cap, the fetch is never called, no second trial starts', async () => {
    const run = setup(TWO);
    const replay = recordingReplay();
    const { deps, out } = testDeps({ providers: replay.providers });
    const code = await evalMain(
      replayArgs(run.path, run.out, '--arms', 'high', '--trials', '1', '--cap-usd', '0.01'),
      deps,
    );
    // a run that ran out of cap completed
    expect(code).toBe(0);
    expect(replay.requests()).toBe(0);
    const rows = rowsIn(run.runDir);
    expect(rows.map((r) => [r.caseId, r.stop])).toEqual([['merge-hand-run', 'spend-cap']]);
    expect(out).toContain('the spend cap refused a request: 1 trials ran');
  });

  it('the control: under the default cap both trials run and reach the replaying fetch', async () => {
    const run = setup(TWO);
    const replay = recordingReplay();
    const code = await evalMain(
      replayArgs(run.path, run.out, '--arms', 'high', '--trials', '1'),
      testDeps({ providers: replay.providers }).deps,
    );
    expect(code).toBe(0);
    expect(replay.requests()).toBe(2);
    const rows = rowsIn(run.runDir);
    expect(rows.map((r) => [r.caseId, r.stop, r.responseModelIds])).toEqual([
      ['merge-hand-run', 'valid', [MODEL]],
      ['merge-trip-days', 'valid', [MODEL]],
    ]);
    const [first] = rows;
    expect(first?.priceTable).toEqual({ date: '2026-11-20', key: `anthropic:${MODEL}` });
    // one token each way at $2 and $10 per million
    expect(first?.cost.measuredUsd).toBeCloseTo(0.000012, 12);
  });
});

describe('a run abort', () => {
  const TWO = ['merge-hand-run', 'merge-trip-days'].map(committedCase);

  it('a step record dropped on the second trial: exit 1, the reason printed, the first trial’s row kept', async () => {
    const run = setup(TWO);
    let trials = 0;
    const { deps, err } = testDeps({
      graphDiagnostics: (port) => {
        trials += 1;
        return trials === 1 ? port : droppingStepRecord(port);
      },
    });
    const code = await evalMain(
      replayArgs(run.path, run.out, '--arms', 'medium', '--trials', '1'),
      deps,
    );
    expect(code).toBe(1);
    expect(rowsIn(run.runDir).map((r) => [r.caseId, r.stop])).toEqual([
      ['merge-hand-run', 'valid'],
    ]);
    expect(err).toContain(
      "model-eval: the run stopped: attempt 1: no model step record at the arm's effort",
    );
    // no report for a run that did not end
    expect(filesIn(run.runDir)).not.toContain('report.md');
  });

  it('the control: the record kept, both trials complete', async () => {
    const run = setup(TWO);
    const code = await evalMain(
      replayArgs(run.path, run.out, '--arms', 'medium', '--trials', '1'),
      testDeps().deps,
    );
    expect(code).toBe(0);
    expect(rowsIn(run.runDir)).toHaveLength(2);
  });
});

describe('the printing gate', () => {
  // The printer prints no reply text: the provider's failure text is the model-side text that reaches a
  // printed line, so it carries the sequences.
  const FAILURE = `upstream ${ESC}[2J${CSI}31m failed`;

  it('a trial whose failure text holds escape sequences: no ESC or CSI in anything printed', async () => {
    const run = setup([committedCase('merge-hand-run')]);
    const failing = failingReplay(FAILURE);
    const { deps, out, err } = testDeps({ providers: failing.providers });
    const code = await evalMain(
      replayArgs(run.path, run.out, '--arms', 'high', '--trials', '1'),
      deps,
    );
    expect(code).toBe(0);
    const printed = [...out, ...err];
    // the failure text was printed, its sequences gone
    expect(printed.some((line) => line.includes('upstream') && line.includes('failed'))).toBe(true);
    expect(printed.filter((line) => line.includes(ESC) || line.includes(CSI))).toEqual([]);

    // the control: the row keeps the sequences, JSON-escaped in the file, so the input carried them
    const [row] = rowsIn(run.runDir);
    expect(row?.stop).toBe('provider-error');
    const stored = row?.attempts[0]?.runError?.message ?? '';
    expect([stored.includes(ESC), stored.includes(CSI)]).toEqual([true, true]);
    expect(failing.thrown.length).toBeGreaterThan(0);
  });
});

describe('the printing gate: a reply holding escape sequences', () => {
  const REPLY = `Sure${ESC}[2J${CSI}31m here it is\n${committedReference('reply-static-text.jsonl')}`;

  it('nothing printed holds an ESC or a CSI, and the row read back keeps them in the reply', async () => {
    const run = setup([committedCase('merge-hand-run')]);
    const { deps, out, err } = testDeps({ providers: answeringReplay(REPLY) });
    const code = await evalMain(
      replayArgs(run.path, run.out, '--arms', 'high', '--trials', '1'),
      deps,
    );
    expect(code).toBe(0);
    expect(out.some((line) => line.startsWith('1/1 merge-hand-run effort-high trial 1: '))).toBe(
      true,
    );
    expect([...out, ...err].filter((line) => line.includes(ESC) || line.includes(CSI))).toEqual([]);
    // the control: the reply in the row, JSON-escaped in the file, still holds the sequences
    expect(readFileSync(join(run.runDir, 'rows.jsonl'), 'utf8')).not.toContain(CSI);
    const reply = rowsIn(run.runDir)[0]?.attempts[0]?.reply ?? '';
    expect([reply.includes(ESC), reply.includes(CSI)]).toEqual([true, true]);
  });
});

describe('the key gate on the replay lane', () => {
  const KEYS = {
    planted: 'sk-ant-api03-Pl4nt3dK3yForTheRunTest0123456789',
    regex: 'rx.*+?^${}()|[]-9f8e7d6c5b4a3210',
    unusual: 'Zq-unusual_shape.0123456789abcdef',
  } as const;
  const holdsKey = (text: string, key: string): boolean => text.includes(key);
  const hand = committedReference('merge-hand-run.jsonl');

  // Everything the run wrote and printed: no file of the run directory and no line holds the key.
  function leaks(runDir: string, printed: readonly string[], key: string): string[] {
    const files = readdirSync(runDir).filter((file) =>
      holdsKey(readFileSync(join(runDir, file), 'utf8'), key),
    );
    return [...files, ...printed.filter((line) => holdsKey(line, key))];
  }

  it.each(Object.entries(KEYS))(
    'the %s key, in a spec and echoed back by the loop: in no file and no printed line',
    async (_kind, key) => {
      // one reply holds the key in a label, the other as a stray key of the press binding
      const references = {
        'key-spec.jsonl': hand.replace('"label":"Merge"', `"label":"Merge ${key}"`),
        'key-echo.jsonl': hand.replace('"action":"merge",', `"action":"merge","${key}":1,`),
      };
      const cases = (['key-spec', 'key-echo'] as const).map((id) => ({
        ...committedCase('merge-hand-run'),
        id,
        reference: `${id}.jsonl`,
      }));
      const run = setup(cases, references);
      // the control: the scanner finds the key in a file written without the writer
      for (const file of Object.keys(references)) {
        expect(holdsKey(readFileSync(join(run.dir, 'references', file), 'utf8'), key)).toBe(true);
      }
      const { deps, out, err } = testDeps({ replayKey: key });
      const code = await evalMain(
        replayArgs(run.path, run.out, '--arms', 'high', '--trials', '1'),
        deps,
      );
      expect(code).toBe(0);
      expect(leaks(run.runDir, [...out, ...err], key)).toEqual([]);
      const [spec, echo] = rowsIn(run.runDir);
      expect([spec?.stop, echo?.stop]).toEqual(['valid', 'exhausted']);
      expect(JSON.stringify(spec?.spec)).toContain(`Merge ${HIDDEN}`);
      expect(echo?.attempts[0]?.reply).toContain(HIDDEN);
      expect(echo?.attempts[1]?.reprompt).toContain(HIDDEN);
    },
  );

  it.each(Object.entries(KEYS))(
    'the %s key, in the message of a failure: in no file and no printed line',
    async (_kind, key) => {
      const run = setup([committedCase('merge-hand-run')]);
      const failing = failingReplay(`request failed for ${key}`);
      const { deps, out, err } = testDeps({ replayKey: key, providers: failing.providers });
      const code = await evalMain(
        replayArgs(run.path, run.out, '--arms', 'high', '--trials', '1'),
        deps,
      );
      expect(code).toBe(0);
      // the control: the failure the fetch threw held the key
      expect(failing.thrown.length).toBeGreaterThan(0);
      expect(failing.thrown.every((message) => holdsKey(message, key))).toBe(true);
      expect(leaks(run.runDir, [...out, ...err], key)).toEqual([]);
      expect(out.some((line) => line.includes('request failed for'))).toBe(true);
    },
  );
});

describe('rowFor: a spec the row cannot hold', () => {
  const PROMPT = composeSystemPrompt(buildCatalogPrompt(videoMergeCatalog), '/run/c01');
  const CASE_FILE = fileURLToPath(new URL('../../eval/cases/generation.v1.jsonl', import.meta.url));
  const caseSet = loadCaseSet(CASE_FILE, { systemPrompt: PROMPT });

  function observation(state: Record<string, unknown>): TrialObservation {
    const spec: MiniAppSpec = {
      root: 'main',
      elements: { main: { type: 'Text', props: { text: 'Ready' } } },
      state,
    };
    return { stop: 'valid', attempts: [], spec, systemPrompt: PROMPT, durationMs: 1 };
  }

  function rowOfCase(id: string, seen: TrialObservation) {
    const found = caseSet.cases.find((c) => c.id === id);
    if (found === undefined) throw new Error(`no committed case ${id}`);
    const diagnostics = recordingDiagnostics();
    const row = rowFor(seen, {
      testCase: found,
      caseDirectory: '/run/c01',
      diagnostics: diagnostics.diagnostics,
      runId: RUN_ID,
      lane: 'dry',
      case: found,
      caseSetVersion: 1,
      gradingVersion: 0,
      arm: 'high',
      trial: 1,
      provider: 'scripted',
      model: 'scripted',
      commit: null,
      priceTable: null,
      fingerprint: '0'.repeat(64),
      cost: { measuredUsd: 0, upperUsd: 0 },
    });
    return { row, warnings: diagnostics.records.filter((r) => r.level === 'warn') };
  }
  const rowOf = (state: Record<string, unknown>) =>
    rowOfCase('cap-pick-folder', observation(state));

  it('a state holding a bigint is not JSON: the row is a harness error with no spec, and a warning', () => {
    const { row, warnings } = rowOf({ count: 1n });
    expect([row.stop, row.spec, row.passAll]).toEqual(['harness-error', null, false]);
    expect(row.checks.find((c) => c.name === 'valid')?.pass).toBe(false);
    expect(warnings.map((w) => [w.msg, w.meta?.stage])).toEqual([['trial harness error', 'row']]);
    // not a model outcome, so no cause: never counted as a model error
    expect(row.cause).toBeNull();
  });

  it('a grader that throws on the spec: the same harness error, and the warning names the grading', () => {
    const { row, warnings } = rowOf({
      get folder(): string {
        throw new Error('a state that cannot be read');
      },
    });
    expect([row.stop, row.spec, row.cause]).toEqual(['harness-error', null, null]);
    expect(warnings.map((w) => [w.msg, w.meta?.stage, w.meta?.message])).toEqual([
      ['trial harness error', 'grade', 'a state that cannot be read'],
    ]);
  });

  it('the control: the same spec with a number keeps its stop, its spec and its cause, and warns nothing', () => {
    const { row, warnings } = rowOf({ count: 1 });
    expect(row.stop).toBe('valid');
    expect(row.spec).toMatchObject({ state: { count: 1 } });
    // a valid spec that misses the described picker: a model error, decided for an outcome trial
    expect(row.cause).toBe('model-error');
    expect(warnings).toEqual([]);
  });

  describe('the capability cause on the row', () => {
    const ended = (stop: StopKind): TrialObservation => ({
      stop,
      attempts: [],
      spec: null,
      systemPrompt: PROMPT,
      durationMs: 1,
    });

    it('a case missing a component keeps that cause on a provider-error trial (a refusal)', () => {
      expect(rowOfCase('cap-sales-chart', ended('provider-error')).row.cause).toBe(
        'missing-component',
      );
    });

    it('the control: the same case on an outcome trial has the same cause', () => {
      expect(rowOfCase('cap-sales-chart', ended('exhausted')).row.cause).toBe('missing-component');
    });

    it('a case with nothing missing has no cause on a harness-error trial', () => {
      expect(rowOfCase('cap-pick-folder', ended('harness-error')).row.cause).toBeNull();
      // the control: on an outcome trial it has one
      expect(rowOfCase('cap-pick-folder', ended('exhausted')).row.cause).toBe('model-error');
    });
  });

  describe('replyFor: the case directory in the reply', () => {
    interface PatchLine {
      readonly path: string;
      readonly value: { readonly inputs: readonly string[]; readonly output: string };
    }
    const stateOf = (reply: string): PatchLine | undefined =>
      reply
        .split('\n')
        .filter((line) => line !== '')
        .map((line): PatchLine => JSON.parse(line))
        .find((line) => line.path === '/state');
    const merge = caseSet.cases.find((c) => c.id === 'merge-hand-run');

    it.each([
      ["the replacement patterns $&, $` and $'", "/run/$&/$`/$'/c01"],
      ['a quote and a backslash', '/run/a"b\\c/c01'],
    ])('a directory holding %s is written byte for byte', (_what, dir) => {
      if (merge === undefined) throw new Error('no committed case merge-hand-run');
      const reply = replyFor(caseSet, merge, dir);
      expect(reply).not.toContain(CASE_DIR);
      expect(stateOf(reply)?.value).toMatchObject({
        inputs: [`${dir}/a.mp4`, `${dir}/b.mp4`],
        output: `${dir}/out.mp4`,
      });
    });
  });
});

describe('schedule: slots and an abort', () => {
  it('a throw starts no new trial; the trial running in the other slot finishes; the throw is returned', async () => {
    const started: string[] = [];
    const finished: string[] = [];
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const halt = await schedule({
      items: ['a', 'b', 'c'],
      arms: ['high'],
      trials: 2,
      concurrency: 2,
      stopped: () => false,
      run: async (job) => {
        started.push(`${job.item}${job.trial}`);
        if (job.item === 'b') {
          // the other slot's trial ends after the abort
          setTimeout(release, 0);
          throw new RunAbort('stop');
        }
        await held;
        finished.push(`${job.item}${job.trial}`);
      },
    });
    expect(halt?.error).toBeInstanceOf(RunAbort);
    expect(started).toEqual(['a1', 'b1']);
    expect(finished).toEqual(['a1']);
  });

  it('the control: with nothing thrown every trial runs, never more cases at once than slots', async () => {
    let running = 0;
    let most = 0;
    const done: string[] = [];
    const halt = await schedule({
      items: ['a', 'b', 'c'],
      arms: ['medium', 'high'],
      trials: 2,
      concurrency: 2,
      stopped: () => false,
      run: async (job) => {
        running += 1;
        most = Math.max(most, running);
        // a trial that lasts past a turn of the event loop, so the two slots overlap
        await new Promise((resolve) => setTimeout(resolve, 1));
        running -= 1;
        done.push(`${job.item}${job.trial}${job.arm}`);
      },
    });
    expect(halt).toBeNull();
    expect(done).toHaveLength(12);
    expect(most).toBe(2);
  });

  it('a trial that ends in the very tick another slot’s trial throws starts no further trial', async () => {
    const started: string[] = [];
    let resolveA = (): void => {};
    let rejectB = (_error: unknown): void => {};
    const a = new Promise<void>((resolve) => {
      resolveA = resolve;
    });
    const b = new Promise<void>((_resolve, reject) => {
      rejectB = reject;
    });
    const halt = await schedule({
      items: ['a', 'b'],
      arms: ['high'],
      trials: 2,
      concurrency: 2,
      stopped: () => false,
      run: (job) => {
        started.push(`${job.item}${job.trial}`);
        // the latch: once both slots hold a trial, one ends and the other throws, together
        if (started.length === 2) {
          resolveA();
          rejectB(new RunAbort('stop'));
        }
        return job.item === 'a' ? a : b;
      },
    });
    expect(halt?.error).toBeInstanceOf(RunAbort);
    expect(started).toEqual(['a1', 'b1']);
  });

  it('stopped: once it says so, no trial starts', async () => {
    let runs = 0;
    const halt = await schedule({
      items: ['a', 'b'],
      arms: ['high'],
      trials: 3,
      concurrency: 1,
      stopped: () => runs >= 2,
      run: async () => {
        runs += 1;
      },
    });
    expect([halt, runs]).toEqual([null, 2]);
  });
});
