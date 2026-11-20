import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSdkLoopRoute, type Effort, type RedactionPolicy } from '@minitui/agent-core';
import { noopDiagnostics, type DiagnosticsPort } from '@minitui/types';
import { MAX_OUTPUT_TOKENS } from '../../src/graph.js';
import { cleaner, keyRedactionPolicy } from '../../src/model-route.js';
import { fixedCapabilities } from '../../eval/harness/scripted.js';
import {
  createSpendMeter,
  trialMeter,
  type FetchLike,
  type Prices,
  type SpendMeter,
} from '../../eval/harness/spend.js';
import {
  RunAbort,
  createStepLog,
  graphDepsFor,
  runTrial,
  type AttemptHooks,
  type Usage,
} from '../../eval/harness/trial.js';
import { anthropicEntry } from '../../eval/providers/anthropic.js';
import { PROVIDERS, type Meter, type ReplayReply } from '../../eval/providers/index.js';
import { OUTPUT } from '../support/fakes.js';

// A planted key: no case and no reply holds it.
const KEY = 'sk-ant-test-replay-0123456789abcdefghij';
const ESC = String.fromCharCode(27);
const DIR = '/work/dir';
const INTENT = 'merge two clips into one file';
const MODEL = 'test-model';
// The id the replayed response names: never the one requested, so a step record holding it came from the reply.
const REPLIED_MODEL = 'replayed-model-id';
// Small enough for the meter's guard: the body holds the whole system prompt, the output limit is far above.
const USAGE: Usage = { inputTokens: 100, outputTokens: 50 };
const EVAL_DIR = fileURLToPath(new URL('../../eval/', import.meta.url));
const STEP_ABORT = "attempt 1: no model step record at the arm's effort";

// $1 per input token (a cache write alike), $2 per output token: a settle at USAGE is $200, exactly.
const PRICES: Prices = { input: 1e6, cacheWrite: 1e6, cacheRead: 5e5, output: 2e6 };
const OUTPUT_USD_PER_TOKEN = 2;
const BIG = 1e12; // a cap no row comes near

const patchText = (patches: readonly unknown[]): string =>
  patches
    .map((patch) => JSON.stringify(patch))
    .join('\n')
    .concat('\n');

const VALID = patchText([
  { op: 'add', path: '/root', value: 'go' },
  { op: 'add', path: '/elements/go', value: { type: 'Button', props: { label: 'Merge' } } },
  { op: 'add', path: '/state', value: { output: OUTPUT } },
]);
// no root: it compiles whole, so the run reaches its finish and reports its usage
const STRUCTURAL = VALID.split('\n').slice(1).join('\n');

const replyOf = (text: string, usage: Usage = USAGE): ReplayReply => ({
  text,
  modelId: REPLIED_MODEL,
  usage,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const fieldOf = (value: unknown, name: string): unknown =>
  isRecord(value) ? value[name] : undefined;

const patternsOf = (policy: RedactionPolicy): string[][] =>
  (policy.extraSecretPatterns ?? []).map((pattern) => [pattern.source, pattern.flags]);

// A trial's meter: a trialMeter's wrap and hooks together, or the identity with no hooks.
interface MeterView {
  readonly wrap: Meter;
  readonly hooks: AttemptHooks | null;
}
const UNMETERED: MeterView = { wrap: (base) => base, hooks: null };

function meterOf(capUsd: number): { readonly meter: SpendMeter; readonly view: MeterView } {
  const meter = createSpendMeter({ capUsd, prices: PRICES, maxOutputTokens: MAX_OUTPUT_TOKENS });
  return { meter, view: trialMeter(meter, 't') };
}

// Forwards every record but the model step one: the recording seam broken on the port the session writes to.
function droppingStepRecord(next: DiagnosticsPort): DiagnosticsPort {
  return {
    warn: (msg, meta) => next.warn(msg, meta),
    debug: (msg, meta) => {
      if (msg !== 'model step') next.debug(msg, meta);
    },
  };
}

interface ReplayOptions {
  readonly arm?: Effort;
  readonly graphEffort?: Effort; // the effort the graph is given; the arm's unless a row breaks it
  readonly meter?: MeterView;
  readonly dropStep?: boolean;
}

// One trial over the replay route: the real graph, the real session and the real model SDK loop, no network.
function replayTrial(replies: readonly ReplayReply[], over: ReplayOptions = {}) {
  const requests: Array<{ readonly url: string; readonly body: unknown }> = [];
  const access = anthropicEntry.replay(KEY);
  const log = createStepLog(noopDiagnostics);
  const arm = over.arm ?? 'medium';
  const meter = over.meter ?? UNMETERED;
  const route = access.route({
    model: MODEL,
    meter: meter.wrap,
    diagnostics: log.port,
    replies,
    onRequest: (request) => requests.push(request),
  });
  const result = runTrial({
    intent: INTENT,
    deps: graphDepsFor({
      route,
      workingDirectory: DIR,
      effort: over.graphEffort ?? arm,
      diagnostics: over.dropStep === true ? droppingStepRecord(log.port) : log.port,
      redactionPolicy: access.redactionPolicy,
      stderr: { write: () => {} },
      capabilities: fixedCapabilities([]),
    }),
    steps: log.steps,
    arm,
    timeoutMs: 10_000,
    now: () => 0,
    hooks: meter.hooks,
  });
  return { result, requests, steps: log.steps };
}

// A meter that notes the base fetch it is given and wraps nothing.
function baseRecorder(): { readonly meter: Meter; readonly bases: readonly FetchLike[] } {
  const bases: FetchLike[] = [];
  return {
    bases,
    meter: (base) => {
      bases.push(base);
      return base;
    },
  };
}

describe('the provider table', () => {
  it('holds one entry, whose id is the route’s provider id and whose key variable is the cli’s', () => {
    expect(Object.keys(PROVIDERS)).toEqual(['anthropic']);
    expect(PROVIDERS.anthropic).toBe(anthropicEntry);
    expect(anthropicEntry.keyVariable).toBe('ANTHROPIC_API_KEY');
    const route = anthropicEntry.replay(KEY).route({
      model: MODEL,
      meter: UNMETERED.wrap,
      diagnostics: noopDiagnostics,
      replies: [],
    });
    expect(route.provider.id).toBe(anthropicEntry.id);
  });
});

describe('live: the key comes from env and nowhere else', () => {
  it.each([
    ['no key', {}],
    ['an unset key', { ANTHROPIC_API_KEY: undefined }],
    ['an empty key', { ANTHROPIC_API_KEY: '' }],
  ])('an environment with %s has no live lane', (_what, env) => {
    expect(anthropicEntry.live(env)).toBeUndefined();
  });

  it('the control: with the key set, live and replay hold exactly the cli’s policy, cleaner and route', () => {
    const live = anthropicEntry.live({ ANTHROPIC_API_KEY: KEY });
    if (live === undefined) throw new Error('a key that is set gave no live lane');
    const dirty = `a ${ESC}[2J line with ${KEY} in it`;
    for (const access of [live, anthropicEntry.replay(KEY)]) {
      expect(patternsOf(access.redactionPolicy)).toEqual(patternsOf(keyRedactionPolicy(KEY)));
      expect(access.clean.line(dirty)).toBe(cleaner(KEY).line(dirty));
      expect(access.clean.line(dirty)).not.toContain(KEY);
    }
    // built, never driven: the live route reaches the network
    const route = live.route({ model: MODEL, meter: UNMETERED.wrap, diagnostics: noopDiagnostics });
    if (!isSdkLoopRoute(route)) throw new Error('the live route is not an SDK-loop route');
    expect([route.provider.id, route.model.modelId]).toEqual([anthropicEntry.id, MODEL]);
  });

  it('the live route hands the real fetch to the trial’s meter', () => {
    const live = anthropicEntry.live({ ANTHROPIC_API_KEY: KEY });
    if (live === undefined) throw new Error('a key that is set gave no live lane');
    const recorder = baseRecorder();
    // built, never driven: no request is sent
    live.route({ model: MODEL, meter: recorder.meter, diagnostics: noopDiagnostics });
    expect(recorder.bases).toHaveLength(1);
    expect(recorder.bases[0]).toBe(globalThis.fetch);
  });

  it('the control: the replay route hands its meter a base that is not the real fetch', () => {
    const recorder = baseRecorder();
    anthropicEntry.replay(KEY).route({
      model: MODEL,
      meter: recorder.meter,
      diagnostics: noopDiagnostics,
      replies: [],
    });
    expect(recorder.bases).toHaveLength(1);
    expect(recorder.bases[0]).not.toBe(globalThis.fetch);
  });

  // What would read the key from somewhere other than the env argument.
  const OUTSIDE_READS: ReadonlyArray<readonly [string, RegExp]> = [
    ['the process environment', /process\.env/],
    ['a file system import', /from ['"](?:node:)?fs(?:\/promises)?['"]/],
    ['a file read', /\b(?:readFile|readFileSync|createReadStream|openSync)\b/],
  ];
  const outsideReadsIn = (text: string): string[] =>
    OUTSIDE_READS.filter(([, pattern]) => pattern.test(text)).map(([what]) => what);

  it('the entry’s source reads no process environment and no file', () => {
    const text = readFileSync(join(EVAL_DIR, 'providers', 'anthropic.ts'), 'utf8');
    expect(outsideReadsIn(text)).toEqual([]);
  });

  it('the control: the same check flags a planted text that reads both', () => {
    const planted =
      "import { readFileSync } from 'node:fs';\n" +
      "const key = process.env.ANTHROPIC_API_KEY ?? readFileSync('/key', 'utf8');\n";
    expect(outsideReadsIn(planted)).toEqual([
      'the process environment',
      'a file system import',
      'a file read',
    ]);
  });
});

describe('the replay route: the real model SDK loop, with no network', () => {
  it.each(['medium', 'high'] as const)(
    'effort %s: the step records the replied model id and the effort, and the body sends that effort',
    async (effort) => {
      const { result, requests } = replayTrial([replyOf(VALID)], { arm: effort });
      const observation = await result;
      expect(observation.stop).toBe('valid');
      expect(observation.attempts[0]?.steps).toEqual([{ effort, modelId: REPLIED_MODEL }]);
      expect(requests).toHaveLength(1);
      const [request] = requests;
      expect(fieldOf(fieldOf(request?.body, 'output_config'), 'effort')).toBe(effort);
      expect(new URL(request?.url ?? 'about:blank').origin).toBe('https://api.anthropic.com');
    },
  );

  it('a request past the last reply fails with a plain error, which is not retried: stop provider-error', async () => {
    const { result, requests } = replayTrial([replyOf(STRUCTURAL)]);
    const observation = await result;
    expect(observation.stop).toBe('provider-error');
    expect(requests).toHaveLength(2);
    expect(observation.attempts.map((a) => a.failure)).toEqual(['structural', null]);
    expect(observation.attempts[1]?.runError?.message).toContain('no reply for request 2');
  });

  it('a clean run, metered: one request per attempt, and every attempt settles at its usage', async () => {
    const { meter, view } = meterOf(BIG);
    const { result, requests } = replayTrial([replyOf(STRUCTURAL), replyOf(VALID)], {
      meter: view,
    });
    const observation = await result;
    expect(observation.stop).toBe('valid');
    expect(requests).toHaveLength(2);
    expect(observation.attempts.map((a) => [a.requests, a.usage])).toEqual([
      [1, USAGE],
      [1, USAGE],
    ]);
    expect([meter.requestsOf('t/1'), meter.requestsOf('t/2')]).toEqual([1, 1]);
    // 100 input tokens at $1 and 50 output tokens at $2, twice
    expect(meter.costOf('t/1')).toEqual({ measuredUsd: 200, upperUsd: 200 });
    expect(meter.costOf('t/2')).toEqual({ measuredUsd: 200, upperUsd: 200 });
    expect([meter.committedUsd, meter.heldUsd, meter.refused]).toEqual([400, 0, false]);
  });
});

describe('the cap through the real route', () => {
  // Below the worst case of any request: the output room alone costs more.
  const BELOW_ONE_WORST_CASE = MAX_OUTPUT_TOKENS * OUTPUT_USD_PER_TOKEN - 1;

  it('a cap below one worst-case request: stop spend-cap, and the replaying fetch is never called', async () => {
    const { meter, view } = meterOf(BELOW_ONE_WORST_CASE);
    const { result, requests } = replayTrial([replyOf(VALID)], { meter: view });
    const observation = await result;
    expect(observation.stop).toBe('spend-cap');
    expect(requests).toHaveLength(0);
    expect(observation.attempts[0]?.requests).toBe(0);
    expect([meter.refused, meter.committedUsd, meter.heldUsd]).toEqual([true, 0, 0]);
  });

  it('the control: the same trial under a cap it fits reaches the replaying fetch', async () => {
    const { view } = meterOf(BIG);
    const { result, requests } = replayTrial([replyOf(VALID)], { meter: view });
    expect((await result).stop).toBe('valid');
    expect(requests).toHaveLength(1);
  });
});

describe('the model step seam', () => {
  it('a step record dropped before the step log: the trial throws a run abort', async () => {
    const { result } = replayTrial([replyOf(VALID)], { dropStep: true });
    await expect(result).rejects.toBeInstanceOf(RunAbort);
    await expect(result).rejects.toThrow(STEP_ABORT);
  });

  it('a graph given another effort than the arm’s: the trial throws a run abort', async () => {
    const { result, requests, steps } = replayTrial([replyOf(VALID)], {
      arm: 'medium',
      graphEffort: 'high',
    });
    await expect(result).rejects.toBeInstanceOf(RunAbort);
    await expect(result).rejects.toThrow(STEP_ABORT);
    // a record was there, at the effort the graph sent, not the arm's
    expect(fieldOf(fieldOf(requests[0]?.body, 'output_config'), 'effort')).toBe('high');
    expect(steps()).toEqual([{ effort: 'high', modelId: REPLIED_MODEL }]);
  });

  it('the control: the record kept and the efforts equal, the same trial completes', async () => {
    const { result } = replayTrial([replyOf(VALID)], { arm: 'medium', graphEffort: 'medium' });
    const observation = await result;
    expect(observation.stop).toBe('valid');
    expect(observation.attempts[0]?.steps).toEqual([{ effort: 'medium', modelId: REPLIED_MODEL }]);
  });
});

describe('the meter’s guard and a dropped step record on the same attempt', () => {
  // More input tokens than the request body has bytes: usage no metered request can have reported.
  const IMPOSSIBLE: Usage = { inputTokens: 100_000_000, outputTokens: 50 };
  const GUARD =
    /^spend guard: reported input tokens \(100000000\) do not fit the largest request body/;

  const metered = (usage: Usage, dropStep: boolean) =>
    replayTrial([replyOf(VALID, usage)], { meter: meterOf(BIG).view, dropStep }).result;

  it('both: the trial rejects with the meter’s abort, not the step record’s', async () => {
    const result = metered(IMPOSSIBLE, true);
    await expect(result).rejects.toBeInstanceOf(RunAbort);
    await expect(result).rejects.toThrow(GUARD);
  });

  it('the control: the guard alone rejects with the meter’s abort', async () => {
    const result = metered(IMPOSSIBLE, false);
    await expect(result).rejects.toBeInstanceOf(RunAbort);
    await expect(result).rejects.toThrow(GUARD);
  });

  it('the control: the dropped record alone rejects with the step record’s abort', async () => {
    const result = metered(USAGE, true);
    await expect(result).rejects.toBeInstanceOf(RunAbort);
    await expect(result).rejects.toThrow(STEP_ABORT);
  });
});

describe('the runner and the graders hold no provider-specific code', () => {
  const PROVIDER_WORDS = ['anthropic', 'claude', '@ai-sdk', 'createAnthropic', 'ANTHROPIC_'];
  const providerWordsIn = (text: string): string[] =>
    PROVIDER_WORDS.filter((word) => text.toLowerCase().includes(word.toLowerCase()));

  const filesUnder = (dir: string): string[] =>
    readdirSync(join(EVAL_DIR, dir), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));

  it('no file under the harness or the graders, and not the entry, names a provider, its package or its key', () => {
    const files = [...filesUnder('harness'), ...filesUnder('graders'), join(EVAL_DIR, 'main.ts')];
    expect(files.map((path) => path.slice(EVAL_DIR.length))).toEqual(
      expect.arrayContaining(['harness/trial.ts', 'harness/row.ts', 'main.ts']),
    );
    const hits = files.flatMap((path) =>
      providerWordsIn(readFileSync(path, 'utf8')).map((word) => `${path}: ${word}`),
    );
    expect(hits).toEqual([]);
  });

  it('the control: the same scan of the provider entry finds its id and its key variable', () => {
    const text = readFileSync(join(EVAL_DIR, 'providers', 'anthropic.ts'), 'utf8');
    expect(providerWordsIn(text)).toEqual(expect.arrayContaining(['anthropic', 'ANTHROPIC_']));
    // the key variable alone spells the first word, so the id is checked on its own
    expect(text).toContain("id: 'anthropic'");
    expect(text).toContain("'ANTHROPIC_API_KEY'");
  });
});
