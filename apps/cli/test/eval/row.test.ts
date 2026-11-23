import { describe, it, expect, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactDeep, type Effort, type RedactionPolicy } from '@minitui/agent-core';
import { MAX_GEN_ATTEMPTS } from '../../src/generation.js';
import { keyRedactionPolicy } from '../../src/model-route.js';
import {
  EVAL_HARNESS_ID,
  toRow,
  writeRows,
  type CheckResult,
  type EvalRow,
  type Lane,
  type RowContext,
} from '../../eval/harness/row.js';
import {
  fixedCapabilities,
  scriptedProvider,
  type ScriptedReply,
} from '../../eval/harness/scripted.js';
import {
  createStepLog,
  graphDepsFor,
  runTrial,
  type TrialObservation,
  type Usage,
} from '../../eval/harness/trial.js';
import { OUTPUT, recordingDiagnostics } from '../support/fakes.js';

const INTENT = 'merge two clips into one file';
const DIR = '/work/dir';
const USAGE: Usage = { inputTokens: 100, outputTokens: 20 };
const SECOND: Usage = { inputTokens: 300, outputTokens: 40 };
const FINGERPRINT = 'f'.repeat(64);
const HIDDEN = '[redacted-secret]';

const text = (body: string, usage: Usage | null = USAGE): ScriptedReply => ({
  kind: 'text',
  text: body,
  usage,
});

// The patch lines of a merge app that passes the loop; the options put a string where a test needs one.
function app(
  over: {
    readonly label?: string;
    readonly extraKey?: string;
    readonly inputs?: readonly string[];
    readonly output?: string;
    readonly extraState?: Record<string, unknown>;
  } = {},
): string {
  const press: Record<string, unknown> = {
    action: 'merge',
    params: {
      inputs: { $state: '/inputs' },
      codec: { $state: '/codec' },
      output: { $state: '/output' },
    },
  };
  if (over.extraKey !== undefined) press[over.extraKey] = 1;
  return [
    { op: 'add', path: '/root', value: 'go' },
    {
      op: 'add',
      path: '/elements/go',
      value: { type: 'Button', props: { label: over.label ?? 'Merge' }, on: { press } },
    },
    {
      op: 'add',
      path: '/state',
      value: {
        inputs: over.inputs ?? ['/abs/a.mp4', '/abs/b.mp4'],
        codec: 'h264',
        output: over.output ?? OUTPUT,
        merge: { progress: 0, status: '' },
        ...over.extraState,
      },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n')
    .concat('\n');
}

// compiles whole and has no root, so the loop reads it as a structural failure
const STRUCTURAL = app().split('\n').slice(1).join('\n');

interface TrialOptions {
  readonly arm?: Effort;
  // the model ids that request n records as `model step` records, as a real route writes them
  readonly steps?: readonly (readonly string[])[];
  // what the graph itself redacts with; the writer is given its own
  readonly policy?: RedactionPolicy;
}

async function trial(
  replies: readonly ScriptedReply[],
  over: TrialOptions = {},
): Promise<TrialObservation> {
  const arm = over.arm ?? 'high';
  const log = createStepLog(recordingDiagnostics().diagnostics);
  let served = 0;
  const provider = scriptedProvider(replies, (request) => {
    for (const modelId of over.steps?.[served] ?? []) {
      log.port.debug('model step', { effort: request.config.effort, modelId });
    }
    served += 1;
  });
  const deps = graphDepsFor({
    route: { provider, model: 'scripted-model' },
    workingDirectory: DIR,
    effort: arm,
    diagnostics: log.port,
    redactionPolicy: over.policy ?? keyRedactionPolicy('sk-test-only-key'),
    stderr: { write: () => {} },
    capabilities: fixedCapabilities(['h264']),
  });
  return runTrial({
    intent: INTENT,
    deps,
    steps: log.steps,
    arm,
    timeoutMs: 5000,
    now: () => performance.now(),
    hooks: null,
  });
}

const CHECKS: readonly CheckResult[] = [
  { name: 'valid', pass: true, evidence: 'the stop kind is valid', diagnostic: false },
  {
    name: 'first-attempt-valid',
    pass: false,
    evidence: 'valid after 2 attempts',
    diagnostic: true,
  },
];

function contextFor(over: Partial<RowContext> = {}): RowContext {
  return {
    runId: 'run-1',
    lane: 'dry',
    case: {
      id: 'merge-two',
      version: 3,
      suite: 'regression',
      split: 'dev',
      catalog: 'video-merge',
    },
    caseSetVersion: 1,
    gradingVersion: 1,
    arm: 'high',
    trial: 2,
    provider: 'scripted',
    model: 'scripted-model',
    commit: null,
    priceTable: null,
    fingerprint: FINGERPRINT,
    checks: CHECKS,
    cause: null,
    cost: { measuredUsd: 0.0123, upperUsd: 0.0456 },
    ...over,
  };
}

const sha256 = (body: string): string => createHash('sha256').update(body).digest('hex');

describe('toRow', () => {
  it('maps a scripted two-attempt trial onto the row, field by field', async () => {
    const observation = await trial([text(STRUCTURAL), text(app(), SECOND)], {
      steps: [
        ['model-b', 'model-a'],
        ['model-a', 'model-c'],
      ],
    });
    expect(observation.stop).toBe('valid');
    const row = toRow(observation, contextFor());

    expect(row).toMatchObject({
      harness: EVAL_HARNESS_ID,
      runId: 'run-1',
      lane: 'dry',
      layer: 'generation',
      caseId: 'merge-two',
      caseVersion: 3,
      caseSetVersion: 1,
      gradingVersion: 1,
      suite: 'regression',
      split: 'dev',
      catalog: 'video-merge',
      arm: 'effort-high',
      trial: 2,
      provider: 'scripted',
      requestedModel: 'scripted-model',
      // every id the steps named, once, in the order they were first seen
      responseModelIds: ['model-b', 'model-a', 'model-c'],
      effortSent: 'high',
      gitCommit: null,
      capabilityFingerprint: FINGERPRINT,
      priceTable: null,
      stop: 'valid',
      checks: CHECKS,
      passAll: true,
      cause: null,
      usage: { inputTokens: 400, outputTokens: 60 },
      cost: { measuredUsd: 0.0123, upperUsd: 0.0456 },
      durationMs: observation.durationMs,
    });
    expect(row.systemPromptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.systemPromptSha256).toBe(sha256(observation.systemPrompt));
    expect(observation.systemPrompt).toContain(JSON.stringify(DIR));

    expect(row.attempts).toEqual([
      {
        index: 1,
        reprompt: null,
        reply: STRUCTURAL,
        failure: 'structural',
        usage: USAGE,
        noUsage: null,
        responseModelIds: ['model-b', 'model-a'],
        effortLabels: ['high', 'high'],
        requests: 0,
        runError: null,
        durationMs: observation.attempts[0]?.durationMs,
      },
      {
        index: 2,
        reprompt: observation.attempts[1]?.reprompt,
        reply: app(),
        failure: null,
        usage: SECOND,
        noUsage: null,
        responseModelIds: ['model-a', 'model-c'],
        effortLabels: ['high', 'high'],
        requests: 0,
        runError: null,
        durationMs: observation.attempts[1]?.durationMs,
      },
    ]);
    expect(typeof row.attempts[1]?.reprompt).toBe('string');
  });

  it('has exactly the fields of the row schema, and no field is absent', async () => {
    const observation = await trial([text(app())]);
    const row = toRow(observation, contextFor());
    expect(Object.keys(row).sort()).toEqual(
      [
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
      ].sort(),
    );
    expect(Object.keys(row.attempts[0] ?? {}).sort()).toEqual(
      [
        'index',
        'reprompt',
        'reply',
        'failure',
        'usage',
        'noUsage',
        'responseModelIds',
        'effortLabels',
        'requests',
        'runError',
        'durationMs',
      ].sort(),
    );
    // a dry lane records no commit, price table or cause: each is null, never undefined
    expect(Object.values(row).filter((value) => value === undefined)).toEqual([]);
    expect(row.attempts[0]?.responseModelIds).toEqual([]);
    expect(row.responseModelIds).toEqual([]);
  });

  it.each(['dry', 'replay', 'live'] as const satisfies readonly Lane[])(
    'carries the lane the run was given: %s',
    async (lane) => {
      const observation = await trial([text(app())]);
      expect(toRow(observation, contextFor({ lane })).lane).toBe(lane);
    },
  );

  it.each(['medium', 'high'] as const satisfies readonly Effort[])(
    'the %s arm is the effort sent, and the labels are what the step records name',
    async (arm) => {
      const observation = await trial([text(STRUCTURAL), text(app())], {
        arm,
        steps: [['model-a'], ['model-a', 'model-a']],
      });
      const row = toRow(observation, contextFor({ arm }));
      expect(row.arm).toBe(`effort-${arm}`);
      expect(row.effortSent).toBe(arm);
      expect(row.attempts.map((a) => a.effortLabels)).toEqual([[arm], [arm, arm]]);
      expect(row.attempts.map((a) => a.responseModelIds)).toEqual([
        ['model-a'],
        ['model-a', 'model-a'],
      ]);
      expect(row.responseModelIds).toEqual(['model-a']);
    },
  );

  it('sums the usage attempts reported and leaves out the one that reported none', async () => {
    const observation = await trial([
      text(STRUCTURAL, USAGE),
      text(STRUCTURAL, null),
      text(app(), SECOND),
    ]);
    const row = toRow(observation, contextFor());
    expect(row.attempts.map((a) => [a.usage, a.noUsage])).toEqual([
      [USAGE, null],
      [null, 'unreported'],
      [SECOND, null],
    ]);
    expect(row.usage).toEqual({ inputTokens: 400, outputTokens: 60 });
  });

  it('passAll needs a valid stop and every check that is not a diagnostic', async () => {
    const valid = await trial([text(app())]);
    const exhausted = await trial(Array.from({ length: MAX_GEN_ATTEMPTS }, () => text(STRUCTURAL)));
    expect(exhausted.stop).toBe('exhausted');
    const check = (name: string, pass: boolean, diagnostic = false): CheckResult => ({
      name,
      pass,
      evidence: pass ? 'as expected' : 'not as expected',
      diagnostic,
    });
    const passAll = (observation: TrialObservation, checks: readonly CheckResult[]): boolean =>
      toRow(observation, contextFor({ checks })).passAll;

    expect(passAll(valid, [check('valid', true), check('merge-on-press', true)])).toBe(true);
    // a failing diagnostic is reported and never counted
    expect(passAll(valid, [check('valid', true), check('escape-free-leaves', false, true)])).toBe(
      true,
    );
    expect(passAll(valid, [check('valid', true), check('output-match', false)])).toBe(false);
    // a trial that never reached a valid spec has no checks to pass, and that is not a pass
    expect(passAll(exhausted, [])).toBe(false);
    expect(passAll(exhausted, [check('merge-on-press', true)])).toBe(false);
  });

  it('keeps null for the spec of a trial that has none, and one entry per attempt', async () => {
    const observation = await trial(
      Array.from({ length: MAX_GEN_ATTEMPTS }, () => text(STRUCTURAL)),
    );
    const row = toRow(observation, contextFor());
    expect(row.stop).toBe('exhausted');
    expect(row.spec).toBeNull();
    expect(row.attempts).toHaveLength(MAX_GEN_ATTEMPTS);
    expect(row.attempts.map((a) => a.index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(row.attempts.map((a) => a.reprompt === null)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('stores a spec with state as JSON, in a copy of its own', async () => {
    const state = {
      clips: { count: 2, names: ['a', 'b'], flags: [true, false, null] },
      ratio: 1.5,
      note: '',
    };
    const observation = await trial([text(app({ extraState: state }))]);
    expect(observation.stop).toBe('valid');
    expect(observation.spec?.state).toMatchObject(state);
    const row = toRow(observation, contextFor());
    // the round trip through JSON text gives back the very same JSON
    expect(JSON.parse(JSON.stringify(row.spec))).toEqual(
      JSON.parse(JSON.stringify(observation.spec)),
    );
    expect(row.spec).toMatchObject({ root: 'go', state });
    // it went through the schema: a fresh tree, not the object the host kept
    expect(row.spec).not.toBe(observation.spec);
    expect(Object.isFrozen(row.spec)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
// The writer. Every file lives in one temporary directory that the suite removes.

const dir = mkdtempSync(join(tmpdir(), 'minitui-row-test-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
let files = 0;
const nextFile = (): string => join(dir, `rows-${(files += 1)}.jsonl`);
const linesOf = (path: string): string[] => readFileSync(path, 'utf8').split('\n').slice(0, -1);
const parseRow = (line: string): EvalRow => JSON.parse(line);

// A file written the way no writer would: the rows as plain JSON text, nothing removed.
function writePlain(path: string, rows: readonly EvalRow[]): void {
  appendFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
}

const byCode = (...codes: readonly number[]): string => String.fromCharCode(...codes);
const CSI = byCode(0x9b); // the C1 control sequence introducer
const DEL = byCode(0x7f);
const NEL = byCode(0x85);
const LAST_C1 = byCode(0x9f);
const LINE_SEP = byCode(0x2028);
const PARA_SEP = byCode(0x2029);
const ESC = byCode(27);
const RAW_SET = [...Array.from({ length: 0x9f - 0x7f + 1 }, (_, i) => 0x7f + i), 0x2028, 0x2029];

// The code points in a file's text that a terminal or a line reader could act on: every control character
// but the newline that ends a line, DEL, the C1 range and the two Unicode line separators.
function raw(fileText: string): number[] {
  return [...fileText]
    .map((c) => c.codePointAt(0) ?? 0)
    .filter(
      (n) => (n < 0x20 && n !== 0x0a) || (n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029,
    );
}

const escaped = (code: number): string => `\\u${code.toString(16).padStart(4, '0')}`;

describe('writeRows: the file', () => {
  it('appends one JSON line per row, in order, across calls', async () => {
    const observation = await trial([text(app())]);
    const rows = [1, 2, 3].map((n) => toRow(observation, contextFor({ trial: n })));
    const path = nextFile();
    writeRows(path, rows.slice(0, 2), keyRedactionPolicy('sk-test-only-key'));
    writeRows(path, rows.slice(2), keyRedactionPolicy('sk-test-only-key'));
    const lines = linesOf(path);
    expect(lines).toHaveLength(3);
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
    expect(lines.map((line) => parseRow(line).trial)).toEqual([1, 2, 3]);
    // nothing secret, nothing to collapse: each line is the row as plain JSON
    expect(lines).toEqual(rows.map((row) => JSON.stringify(row)));
  });

  it('leaves no raw DEL, C1 control, U+2028 or U+2029 in the file, and the reply comes back whole', async () => {
    const reply = `before${CSI}2J${DEL}${NEL}${LAST_C1}${LINE_SEP}${PARA_SEP}${ESC}[31m after\nnext line`;
    const observation = await trial([text(`${reply}\n${app()}`), text(app())]);
    expect(observation.attempts[0]?.reply).toContain(CSI);
    const row = toRow(observation, contextFor());

    // the control: plain JSON text leaves these raw (it escapes the escape character itself), which is
    // why the writer has a step of its own for them
    const sent = [0x7f, 0x85, 0x9b, 0x9f, 0x2028, 0x2029];
    const plain = nextFile();
    writePlain(plain, [row]);
    expect([...new Set(raw(readFileSync(plain, 'utf8')))].sort((a, b) => a - b)).toEqual(sent);

    const path = nextFile();
    writeRows(path, [row], keyRedactionPolicy('sk-test-only-key'));
    const written = readFileSync(path, 'utf8');
    expect(raw(written)).toEqual([]);
    expect(linesOf(path)).toHaveLength(1);
    for (const code of [...sent, 27]) expect(written).toContain(escaped(code));
    // read back, the escapes are the characters: nothing was stripped or changed on the way
    const [line] = linesOf(path);
    expect(parseRow(line ?? '').attempts[0]?.reply).toBe(`${reply}\n${app()}`);
  });

  it('escapes every code point from DEL through the C1 range, and U+2028 and U+2029, and no other', async () => {
    const all = RAW_SET.map((code) => byCode(code)).join('');
    // the code points around the set stay as they are: a tilde, no-break space, a hyphenation point, an e acute
    const around = byCode(0x7e, 0xa0, 0xe9, 0x2027, 0x202a);
    const observation = await trial([text(`${all}${around}\n${app()}`), text(app())]);
    const row = toRow(observation, contextFor());
    const path = nextFile();
    writeRows(path, [row], keyRedactionPolicy('sk-test-only-key'));
    const written = readFileSync(path, 'utf8');
    expect(raw(written)).toEqual([]);
    for (const code of RAW_SET) expect(written).toContain(escaped(code));
    expect(written).toContain(around);
    const [line] = linesOf(path);
    expect(parseRow(line ?? '').attempts[0]?.reply.startsWith(`${all}${around}`)).toBe(true);
  });
});

describe('writeRows: paths', () => {
  const KEY = 'sk-ant-api03-PathTestKey0123456789abcdefgh';

  it('keeps a case path under the temporary or the home directory byte for byte', async () => {
    const inputs = [join(homedir(), 'clips', 'a.mp4'), join(homedir(), 'clips', 'b.mp4')];
    const output = join(tmpdir(), 'run-1', 'case-a', 'merged.mp4');
    // the control: the policy the cli builds, applied as it stands, collapses all of them to something
    // else, with the directories of this machine
    for (const p of [...inputs, output]) {
      expect(redactDeep(p, keyRedactionPolicy(KEY))).not.toBe(p);
    }

    const observation = await trial([text(app({ inputs, output }))]);
    expect(observation.stop).toBe('valid');
    const path = nextFile();
    writeRows(path, [toRow(observation, contextFor())], keyRedactionPolicy(KEY));
    const [line] = linesOf(path);
    const written = parseRow(line ?? '');
    expect(written.spec).toMatchObject({ state: { inputs, output } });
    expect(written.attempts[0]?.reply).toBe(app({ inputs, output }));
    expect(readFileSync(path, 'utf8')).toContain(JSON.stringify(output));
  });

  it('keeps them when the policy it is given names directories to collapse', async () => {
    const policy: RedactionPolicy = {
      ...keyRedactionPolicy(KEY),
      tmpDir: '/srv/planted-tmp',
      homeDir: '/srv/planted-home',
    };
    const paths = ['/srv/planted-tmp/run-1/case-a/a.mp4', '/srv/planted-home/clips/b.mp4'];
    // the control: that policy, applied as it stands, collapses both
    expect(paths.map((p) => redactDeep(p, policy))).toEqual([
      '$TMPDIR/run-1/case-a/a.mp4',
      '~/clips/b.mp4',
    ]);

    const reply = `I looked in ${paths[0]} and in ${paths[1]}`;
    const observation = await trial([text(`${reply}\n${app()}`), text(app())]);
    const path = nextFile();
    writeRows(path, [toRow(observation, contextFor())], policy);
    const [line] = linesOf(path);
    expect(parseRow(line ?? '').attempts[0]?.reply).toBe(`${reply}\n${app()}`);
    // the policy object the caller holds is as it was
    expect([policy.tmpDir, policy.homeDir]).toEqual(['/srv/planted-tmp', '/srv/planted-home']);
  });
});

// ---------------------------------------------------------------------------------------------------
// The key gate: the key is in no row the writer writes, whatever carried it.

const KEYS = {
  // the shape of a real key: the shape patterns remove it as well
  planted: 'sk-ant-api03-Pl4nt3dK3yForTheRowTest0123456789',
  // regular-expression characters and no known prefix
  regex: 'rx.*+?^${}()|[]-9f8e7d6c5b4a3210',
  // no known prefix: only the exact-value pattern removes it
  unusual: 'Zq-unusual_shape.0123456789abcdef',
} as const;

// The scanner: whether a key sits in a file's text. None of these keys holds a character that JSON writes
// differently, so the key is its own spelling in the file.
const holdsKey = (fileText: string, key: string): boolean => fileText.includes(key);

type Kind = keyof typeof KEYS;
type Place = 'echo' | 'spec' | 'error';

// The trial's graph redacts with another key, so the writer is the only thing that knows this one: the
// session removes the exact key it is given from a provider's message, and the row would never hold it.
async function observationHolding(key: string, place: Place): Promise<TrialObservation> {
  const policy = keyRedactionPolicy('sk-another-key-0123456789');
  if (place === 'echo') {
    // the reply echoes the key as a stray key of the patch, and the loop quotes it back in its reprompt
    return trial([text(app({ extraKey: key })), text(app())], { policy });
  }
  if (place === 'spec') return trial([text(app({ label: `go ${key}` }))], { policy });
  return trial([{ kind: 'error', message: `request failed for ${key}`, retriable: false }], {
    policy,
  });
}

// The fields a place is about: the key is in each of them before the writer and in none of them after.
function fieldsOf(row: EvalRow, place: Place): string[] {
  if (place === 'echo') return [row.attempts[0]?.reply ?? '', row.attempts[1]?.reprompt ?? ''];
  if (place === 'spec') return [JSON.stringify(row.spec)];
  return [row.attempts[0]?.runError?.message ?? ''];
}

describe('writeRows: the key gate', () => {
  // A key of the standard shape is not tried in an error message: the session's shape patterns remove it
  // from a provider's message before the observation, so no row holds it there and the control says so.
  it.each([
    ['planted', 'echo'],
    ['planted', 'spec'],
    ['regex', 'echo'],
    ['regex', 'spec'],
    ['regex', 'error'],
    ['unusual', 'echo'],
    ['unusual', 'spec'],
    ['unusual', 'error'],
  ] as const satisfies readonly (readonly [Kind, Place])[])(
    'the %s key in the %s place: the scanner detects it without the writer, and not with it',
    async (kind, place) => {
      const key = KEYS[kind];
      const row = toRow(await observationHolding(key, place), contextFor());
      for (const field of fieldsOf(row, place)) expect(field).toContain(key);

      // the control, for this very row: the scanner on a file written without the writer detects the key
      const plain = nextFile();
      writePlain(plain, [row]);
      expect(holdsKey(readFileSync(plain, 'utf8'), key)).toBe(true);

      const path = nextFile();
      writeRows(path, [row], keyRedactionPolicy(key));
      const written = readFileSync(path, 'utf8');
      expect(holdsKey(written, key)).toBe(false);
      for (const field of fieldsOf(parseRow(linesOf(path)[0] ?? ''), place)) {
        expect(field).not.toContain(key);
        expect(field).toContain(HIDDEN);
      }
      // the row the caller holds is as it was
      for (const field of fieldsOf(row, place)) expect(field).toContain(key);
    },
  );

  it('the keys of no known shape are removed by the exact-value pattern alone', () => {
    const line = (key: string): string => `request failed for ${key} on the second try`;
    for (const kind of ['regex', 'unusual'] as const) {
      expect(redactDeep(line(KEYS[kind]))).toBe(line(KEYS[kind]));
      expect(redactDeep(line(KEYS[kind]), keyRedactionPolicy(KEYS[kind]))).toBe(line(HIDDEN));
    }
    expect(redactDeep(line(KEYS.planted))).toBe(line(HIDDEN));
  });
});
