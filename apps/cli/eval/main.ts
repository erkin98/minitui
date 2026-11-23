import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { EFFORTS, type Effort } from '@minitui/agent-core';
import { buildCatalogPrompt, videoMergeCatalog } from '@minitui/catalog';
import { createCapabilityProvider } from '@minitui/exec';
import type { CapabilityProvider } from '@minitui/spec';
import type { DiagnosticsPort } from '@minitui/types';
import { createFileDiagnostics, openLogFile, realProcess, type ProcessPort } from '../src/boot.js';
import { composeSystemPrompt } from '../src/generation.js';
import { MAX_OUTPUT_TOKENS } from '../src/graph.js';
import { cleaner, keyRedactionPolicy, type Cleaner } from '../src/model-route.js';
import { GRADING_VERSION } from './graders/index.js';
import { loadCaseSet, type CaseSet } from './harness/cases.js';
import { createRunRoot, type RunRoot } from './harness/fixtures.js';
import { plural, renderReport, type ReportMeta } from './harness/report.js';
import { EVAL_HARNESS_ID, type Lane } from './harness/row.js';
import {
  dryLane,
  liveLane,
  replayLane,
  runEval,
  type LaneSetup,
  type RunPlan,
} from './harness/run.js';
import {
  PRICE_TABLE_MAX_AGE_DAYS,
  createSpendMeter,
  loadPriceTable,
  type Prices,
  type SpendMeter,
} from './harness/spend.js';
import { PROVIDERS, type ProviderEntry } from './providers/index.js';

const USAGE = `usage: model-eval --cases <file> --arms <efforts> --trials <n> [--suite regression|capability]
                  [--only <ids>] [--out <dir>] [--concurrency <n>] [--trial-timeout-s <n>] <lane>
  --dry-run                       the scripted provider: no key, no network
  --provider <id> --model <id> --replay [--cap-usd <n>]
                                  the real model SDK loop over the replaying fetch; the cap defaults to
                                  1.00, which holds one worst-case request at a time, so a run above
                                  --concurrency 1 needs a larger --cap-usd
  --provider <id> --model <id> --paid --cap-usd <n> --commit <sha>
                                  live; also needs MINITUI_EVAL_PAID=1 and CI empty or absent
--arms is a comma list of ${EFFORTS.join(', ')}; --concurrency is 1 to 4 (default 1);
--trial-timeout-s is 121 to 2147483 (default 900); --commit is the 40-character hex sha being run`;

const DEFAULT_OUT = fileURLToPath(new URL('./results', import.meta.url));
const PRICE_FILE = new URL('./prices.json', import.meta.url);
const PLACEHOLDER_KEY = 'minitui-placeholder-key';
const DEFAULT_REPLAY_CAP_USD = 1;
const DEFAULT_TIMEOUT_S = 900;
const FLOOR_BODY_BYTES = 65_536;

/** The entry's seams: each defaults to the real thing, and they are the only way a test reaches the run. */
export interface EvalDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  readonly randomHex?: (bytes: number) => string;
  readonly priceText?: () => string;
  readonly providers?: Readonly<Record<string, ProviderEntry>>;
  readonly capabilities?: CapabilityProvider;
  readonly replayKey?: string;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  /** Applied to each trial's step-log port before the graph is given it. */
  readonly graphDiagnostics?: (port: DiagnosticsPort) => DiagnosticsPort;
}

type Seams = Required<Omit<EvalDeps, 'capabilities'>> & {
  readonly capabilities: () => CapabilityProvider;
};

function withDefaults(deps: EvalDeps): Seams {
  return {
    env: deps.env ?? process.env,
    now: deps.now ?? (() => new Date()),
    randomHex: deps.randomHex ?? ((bytes) => randomBytes(bytes).toString('hex')),
    priceText: deps.priceText ?? (() => readFileSync(PRICE_FILE, 'utf8')),
    providers: deps.providers ?? PROVIDERS,
    capabilities: () => deps.capabilities ?? createCapabilityProvider(),
    replayKey: deps.replayKey ?? PLACEHOLDER_KEY,
    stdout:
      deps.stdout ??
      ((line) => {
        process.stdout.write(`${line}\n`);
      }),
    stderr:
      deps.stderr ??
      ((line) => {
        process.stderr.write(`${line}\n`);
      }),
    graphDiagnostics: deps.graphDiagnostics ?? ((port) => port),
  };
}

/** A refused argument, opt-in condition, price table, cap or case selection: exit 2. */
class Refusal extends Error {}
const refuse = (message: string): never => {
  throw new Refusal(message);
};
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface Flags {
  readonly cases: string;
  readonly arms: readonly Effort[];
  readonly trials: number;
  readonly suite: 'regression' | 'capability' | null;
  readonly only: readonly string[] | null;
  readonly out: string;
  readonly concurrency: number;
  readonly timeoutS: number;
  readonly lane: Lane;
  readonly provider: string;
  readonly model: string;
  readonly capUsd: number | null;
  readonly commit: string | null;
}

const OPTIONS = {
  cases: { type: 'string' },
  arms: { type: 'string' },
  trials: { type: 'string' },
  suite: { type: 'string' },
  only: { type: 'string' },
  out: { type: 'string' },
  concurrency: { type: 'string' },
  'trial-timeout-s': { type: 'string' },
  'dry-run': { type: 'boolean' },
  replay: { type: 'boolean' },
  paid: { type: 'boolean' },
  provider: { type: 'string' },
  model: { type: 'string' },
  'cap-usd': { type: 'string' },
  commit: { type: 'string' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>['values'];

const required = (name: string, text: string | undefined): string =>
  text === undefined || text === '' ? refuse(`--${name} is required`) : text;

function wholeNumber(name: string, text: string, min: number, max: number): number {
  const n = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  return n >= min && n <= max
    ? n
    : refuse(`--${name} must be a whole number from ${min} to ${max}`);
}

function armsOf(text: string): Effort[] {
  const arms = text
    .split(',')
    .map(
      (name) =>
        EFFORTS.find((effort) => effort === name) ??
        refuse(`--arms takes efforts from ${EFFORTS.join(', ')}; "${name}" is not one`),
    );
  return new Set(arms).size === arms.length ? arms : refuse('--arms names an effort twice');
}

function laneOf(values: Values): Lane {
  const chosen = (
    [
      ['dry', values['dry-run']],
      ['replay', values.replay],
      ['live', values.paid],
    ] as const
  ).filter(([, given]) => given === true);
  const [only] = chosen;
  return chosen.length === 1 && only !== undefined
    ? only[0]
    : refuse('choose exactly one lane: --dry-run, --replay or --paid');
}

const capOf = (text: string): number =>
  /^\d+(\.\d+)?$/.test(text) ? Number(text) : refuse('--cap-usd must be a number of dollars');

const commitOf = (text: string): string =>
  /^[0-9a-f]{40}$/i.test(text) ? text : refuse('--commit must be a 40-character hex sha');

// The flags of the lane: the dry lane takes no provider, model or cap; the others need a provider and model.
function laneFlags(values: Values, lane: Lane) {
  if (lane === 'dry') {
    const given = [values.provider, values.model, values['cap-usd']].some((v) => v !== undefined);
    if (given) refuse('--provider, --model and --cap-usd are not for --dry-run');
    return { provider: '', model: '', capUsd: null };
  }
  const cap = values['cap-usd'];
  return {
    provider: required('provider', values.provider),
    model: required('model', values.model),
    capUsd: cap === undefined ? null : capOf(cap),
  };
}

function selectionOf(values: Values): Pick<Flags, 'suite' | 'only'> {
  const { suite, only } = values;
  if (suite !== undefined && suite !== 'regression' && suite !== 'capability') {
    refuse('--suite is regression or capability');
  }
  const ids = only?.split(',').filter((id) => id !== '');
  if (ids?.length === 0) refuse('--only names no case id');
  return {
    suite: suite === 'regression' || suite === 'capability' ? suite : null,
    only: ids ?? null,
  };
}

/** The flags, each checked; one leading `--` (pnpm forwards it to the script) is dropped first. */
function parseFlags(argv: readonly string[]): Flags {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  const { values } = parseArgs({ args, options: OPTIONS, strict: true, allowPositionals: false });
  const lane = laneOf(values);
  const timeout = values['trial-timeout-s'];
  return {
    cases: required('cases', values.cases),
    arms: armsOf(required('arms', values.arms)),
    trials: wholeNumber('trials', required('trials', values.trials), 1, Number.MAX_SAFE_INTEGER),
    ...selectionOf(values),
    out: values.out ?? DEFAULT_OUT,
    concurrency: wholeNumber('concurrency', values.concurrency ?? '1', 1, 4),
    // a timer past 2^31 - 1 ms fires at once
    timeoutS: wholeNumber('trial-timeout-s', timeout ?? String(DEFAULT_TIMEOUT_S), 121, 2_147_483),
    lane,
    ...laneFlags(values, lane),
    commit: values.commit === undefined ? null : commitOf(values.commit),
  };
}

// ---------------------------------------------------------------------------------------------------
// The lane: its gates, its prices and meter, and its key.

interface Opened {
  readonly setup: LaneSetup;
  readonly clean: Cleaner;
  readonly capUsd: number | null;
  readonly budget: string | null; // printed before the first trial of a paid run
}

const usd = (value: number): string => `$${value.toFixed(4)}`;

// What the meter holds when a metered run ends or stops, to set beside the provider's bill: the aborted
// trial leaves no row, but its attempt is in the total.
const spendLine = (meter: SpendMeter, trials: number): string =>
  `spend: ${usd(meter.committedUsd)} committed, ${usd(meter.heldUsd)} held, cap ${usd(meter.capUsd)}; ${plural(trials, 'trial')} written`;

// What a paid run still lacks; checked before any provider entry is called.
function paidMissing(flags: Flags, env: Seams['env']): string[] {
  const unset = (value: string | undefined) => value === undefined || value === '';
  return [
    env.MINITUI_EVAL_PAID === '1' ? null : 'MINITUI_EVAL_PAID=1',
    unset(env.CI) ? null : 'CI empty or absent',
    flags.capUsd !== null && flags.capUsd > 0 ? null : '--cap-usd above 0',
    flags.commit !== null ? null : '--commit <sha>',
  ].filter((what) => what !== null);
}

function pricesFor(flags: Flags, seams: Seams): { readonly date: string; readonly prices: Prices } {
  let text: string;
  try {
    text = seams.priceText();
  } catch (error) {
    return refuse(`price table: cannot be read (${messageOf(error)})`);
  }
  const loaded = loadPriceTable({
    text,
    key: `${flags.provider}:${flags.model}`,
    now: seams.now(),
    maxAgeDays: flags.lane === 'live' ? PRICE_TABLE_MAX_AGE_DAYS : null,
  });
  return 'refused' in loaded
    ? refuse(loaded.refused)
    : { date: loaded.table.date, prices: loaded.prices };
}

// ponytail: the meter's own worst case, read from a probe meter rather than written again here
function worstCase(prices: Prices): number {
  const probe = createSpendMeter({
    capUsd: Number.MAX_VALUE,
    prices,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  probe.reserve('worst case', FLOOR_BODY_BYTES);
  return probe.heldUsd;
}

/** Opens the lane, or refuses (Refusal, exit 2), or finds no key or a live entry that throws (exit 1); no request is sent here. */
function openLane(flags: Flags, seams: Seams): Opened | { readonly fatal: string } {
  if (flags.lane === 'dry') {
    const policy = keyRedactionPolicy(seams.replayKey);
    return { setup: dryLane(policy), clean: cleaner(seams.replayKey), capUsd: null, budget: null };
  }
  const missing = flags.lane === 'live' ? paidMissing(flags, seams.env) : [];
  if (missing.length > 0) refuse(`a paid run needs ${missing.join(', ')}`);
  const { provider, model } = flags;
  const entry = Object.hasOwn(seams.providers, provider) ? seams.providers[provider] : undefined;
  if (entry === undefined) {
    return refuse(`no provider "${provider}"; known: ${Object.keys(seams.providers).join(', ')}`);
  }
  const { date, prices } = pricesFor(flags, seams);
  const capUsd = flags.capUsd ?? DEFAULT_REPLAY_CAP_USD;
  const meter = createSpendMeter({ capUsd, prices, maxOutputTokens: MAX_OUTPUT_TOKENS });
  const lane = { provider, model, meter, priceTable: { date, key: `${provider}:${model}` } };
  if (flags.lane === 'replay') {
    const access = entry.replay(seams.replayKey);
    return { setup: replayLane({ ...lane, access }), clean: access.clean, capUsd, budget: null };
  }
  const worst = worstCase(prices);
  const floor = 2 * worst * flags.concurrency;
  if (capUsd < floor) {
    refuse(
      `--cap-usd ${capUsd} is below the floor of ${usd(floor)}: twice the worst case of a 65,536-byte request, per slot`,
    );
  }
  let access: ReturnType<ProviderEntry['live']>;
  try {
    access = entry.live(seams.env);
  } catch {
    // its message could hold the key, which no cleaner here knows yet: none of it is printed
    return { fatal: `the provider "${provider}" failed while opening its live route` };
  }
  if (access === undefined) return { fatal: `${entry.keyVariable} is not set` };
  const budget = `usable budget ${usd(capUsd - worst * flags.concurrency)}: the cap ${usd(capUsd)} less one worst case of ${usd(worst)} per slot`;
  return { setup: liveLane({ ...lane, access }), clean: access.clean, capUsd, budget };
}

// ---------------------------------------------------------------------------------------------------
// The run.

const runIdOf = (start: Date, hex: string): string =>
  `${start.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z-${hex}`;

/**
 * The prompt the case loader checks case text against. `buildAppGraph` (src/graph.ts) composes the prompt
 * the trials send with the same call, for the trial's directory: change the two together.
 */
export const systemPromptFor = (directory: string): string =>
  composeSystemPrompt(buildCatalogPrompt(videoMergeCatalog), directory);

function casesFor(flags: Flags, root: RunRoot): CaseSet {
  const systemPrompt = systemPromptFor(root.dirFor(1));
  try {
    return loadCaseSet(flags.cases, { systemPrompt });
  } catch (error) {
    return refuse(`the case set: ${messageOf(error)}`);
  }
}

function select(caseSet: CaseSet, flags: Flags): RunPlan['selected'] {
  const known = new Set(caseSet.cases.map((c) => c.id));
  const unknown = (flags.only ?? []).filter((id) => !known.has(id));
  if (unknown.length > 0) refuse(`--only names no case ${unknown.join(', ')}`);
  const selected = caseSet.cases
    .map((testCase, i) => ({ testCase, position: i + 1 }))
    .filter(({ testCase }) => flags.suite === null || testCase.suite === flags.suite)
    .filter(({ testCase }) => flags.only === null || flags.only.includes(testCase.id));
  return selected.length > 0 ? selected : refuse('no case is selected');
}

interface Started {
  readonly runId: string;
  readonly runDir: string;
  readonly caseSet: CaseSet;
  readonly selected: RunPlan['selected'];
  readonly meta: ReportMeta;
}

// The case set and its selection, then the run directory and its run.json: nothing is created for a
// refused case file or selection.
function startRun(
  flags: Flags,
  opened: Opened,
  seams: Seams,
  root: RunRoot,
  fingerprint: string,
): Started {
  const { setup } = opened;
  const caseSet = casesFor(flags, root);
  const selected = select(caseSet, flags);
  const runId = runIdOf(seams.now(), seams.randomHex(4));
  const runDir = join(flags.out, runId);
  mkdirSync(flags.out, { recursive: true });
  mkdirSync(runDir); // a second run with the same id is refused here, never appended to
  const meta: ReportMeta = {
    runId,
    lane: setup.lane,
    provider: setup.provider,
    model: setup.model,
    caseSetVersion: caseSet.caseSetVersion,
    caseSetStatus: caseSet.status,
    gradingVersion: GRADING_VERSION,
    arms: flags.arms,
    trials: flags.trials,
    concurrency: flags.concurrency,
    regressionCases: selected
      .filter(({ testCase }) => testCase.suite === 'regression')
      .map(({ testCase }) => testCase.id),
    loadedRegressionCases: caseSet.cases.filter((c) => c.suite === 'regression').length,
  };
  const run = {
    harness: EVAL_HARNESS_ID,
    ...meta,
    flags: { ...flags, capUsd: opened.capUsd },
    priceTable: setup.priceTable,
    trialTimeoutS: flags.timeoutS,
    capabilityFingerprint: fingerprint,
    cases: selected.map(({ testCase }) => testCase.id),
  };
  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  return { runId, runDir, caseSet, selected, meta };
}

async function runWith(flags: Flags, opened: Opened, seams: Seams): Promise<number> {
  const { setup, clean } = opened;
  const say = (line: string) => seams.stdout(clean.line(line));
  const capabilities = seams.capabilities();
  const encoders = await capabilities.listEncoders();
  const fingerprint = createHash('sha256').update(encoders.toSorted().join('\n')).digest('hex');
  const root = await createRunRoot();
  try {
    const { runId, runDir, caseSet, selected, meta } = startRun(
      flags,
      opened,
      seams,
      root,
      fingerprint,
    );
    say(
      `run ${runId}: ${setup.lane} lane, ${selected.length} cases, arms ${flags.arms.join(',')}, ${flags.trials} trials each, in ${runDir}`,
    );
    if (opened.budget !== null) say(opened.budget);
    const log = openLogFile(join(runDir, 'diagnostics.log'));
    const { rows, halt } = await runEval({
      runId,
      lane: setup,
      caseSet,
      selected,
      arms: flags.arms,
      trials: flags.trials,
      concurrency: flags.concurrency,
      timeoutMs: flags.timeoutS * 1000,
      commit: flags.commit,
      fingerprint,
      capabilities,
      root,
      rowsPath: join(runDir, 'rows.jsonl'),
      diagnostics: createFileDiagnostics(log, clean.line),
      graphDiagnostics: seams.graphDiagnostics,
      progress: say,
    }).finally(() => log.close());
    // both exits say what the meter saw, before anything that can still throw
    if (setup.meter !== null) say(spendLine(setup.meter, rows.length));
    if (halt !== null) {
      seams.stderr(clean.line(`model-eval: the run stopped: ${clean.message(halt.error)}`));
      return 1;
    }
    writeFileSync(join(runDir, 'report.md'), renderReport(rows, meta));
    if (setup.meter?.refused === true) {
      say(`the spend cap refused a request: ${plural(rows.length, 'trial')} ran`);
    }
    say(`report: ${join(runDir, 'report.md')}`);
    return 0;
  } finally {
    await root.dispose();
  }
}

/**
 * The eval: parse, open the lane (every refusal before a key is read, and the key before any request),
 * then run the trials and write the report. Returns the exit code: 0 for a run that completed, whatever
 * its outcomes; 1 for a run abort or a missing key; 2 for a refusal.
 */
export async function evalMain(argv: readonly string[], deps: EvalDeps = {}): Promise<number> {
  const seams = withDefaults(deps);
  let clean = cleaner(seams.replayKey);
  const fail = (code: number, error: unknown): number => {
    seams.stderr(clean.line(`model-eval: ${clean.message(error)}`));
    return code;
  };
  let flags: Flags;
  try {
    flags = parseFlags(argv);
  } catch (error) {
    fail(2, error);
    for (const line of USAGE.split('\n')) seams.stderr(clean.line(line));
    return 2;
  }
  try {
    const opened = openLane(flags, seams);
    if ('fatal' in opened) return fail(1, opened.fatal);
    clean = opened.clean;
    return await runWith(flags, opened, seams);
  } catch (error) {
    return fail(error instanceof Refusal ? 2 : 1, error);
  }
}

/**
 * Whether the program being run is this module. `entry` is the path the process was started with, which
 * can go through a symlink: both sides are compared as real paths, so a start through one still runs. A
 * path with nothing at it is no entry.
 */
export function isEntryModule(entry: string | undefined, moduleUrl: string): boolean {
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

const CRASH_LINE = 'model-eval: stopped by an unexpected error';

/**
 * Answers a crash that evalMain's own catch cannot see (an uncaught throw, a rejection in a detached
 * callback): one fixed line through the placeholder key's cleaner, then exit 1. Nothing the crash holds is
 * printed, so no cleaner has a key to miss in it, the lane's own included.
 */
export function guardCrashes(proc: ProcessPort, write: (line: string) => void): void {
  const clean = cleaner(PLACEHOLDER_KEY);
  proc.onCrash(() => {
    try {
      write(clean.line(CRASH_LINE));
    } catch {
      // stderr may be closed too: the exit below still happens
    }
    proc.exit(1);
  });
}

if (isEntryModule(process.argv[1], import.meta.url)) {
  guardCrashes(realProcess, (line) => {
    process.stderr.write(`${line}\n`);
  });
  process.exitCode = await evalMain(process.argv.slice(2));
}
