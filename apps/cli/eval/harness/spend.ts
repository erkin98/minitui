import type { EvalRow } from './row.js';
import { RunAbort, type AttemptHooks, type Usage } from './trial.js';

export type FetchLike = typeof globalThis.fetch;

export interface Prices {
  readonly input: number; // USD per million tokens
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly output: number;
}

export interface PriceTable {
  readonly date: string; // the day the prices were read, YYYY-MM-DD
  readonly source: string; // where they were read
  readonly models: Readonly<Record<string, Prices>>; // keyed "provider:model"
}

/** A run more than a month after the prices were read re-reads them first. */
export const PRICE_TABLE_MAX_AGE_DAYS = 30;

const DAY_MS = 86_400_000;
const PER_MILLION = 1_000_000;

type Cost = EvalRow['cost'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isRate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

// The four rates of one entry, or the name of the first that is not a finite number above zero.
function readPrices(entry: unknown): Prices | { readonly bad: string } {
  const rates: Record<string, unknown> = isRecord(entry) ? entry : {};
  const { input, cacheWrite, cacheRead, output } = rates;
  if (!isRate(input)) return { bad: 'input' };
  if (!isRate(cacheWrite)) return { bad: 'cacheWrite' };
  if (!isRate(cacheRead)) return { bad: 'cacheRead' };
  if (!isRate(output)) return { bad: 'output' };
  return { input, cacheWrite, cacheRead, output };
}

// The day a YYYY-MM-DD text names, as whole days since the epoch (UTC); null when it is no calendar day.
function dayNumber(text: string): number | null {
  const ms = Date.parse(`${text}T00:00:00Z`);
  const real =
    /^\d{4}-\d{2}-\d{2}$/.test(text) &&
    Number.isFinite(ms) &&
    new Date(ms).toISOString().startsWith(text);
  return real ? ms / DAY_MS : null;
}

// The table a file's text holds, with the day its date names; or the reason the text is not one.
function readTable(text: string): { readonly table: PriceTable; readonly day: number } | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'not valid JSON';
  }
  if (!isRecord(parsed) || typeof parsed.source !== 'string' || !isRecord(parsed.models)) {
    return 'expected an object with a date, a source and a models object';
  }
  // Every entry is read, not only the requested one: a rate that is zero anywhere in the file is a bad file.
  const entries: Array<readonly [string, Prices]> = [];
  for (const [model, entry] of Object.entries(parsed.models)) {
    const prices = readPrices(entry);
    if ('bad' in prices) return `${model}.${prices.bad} is not a finite number above zero`;
    entries.push([model, prices]);
  }
  const { date } = parsed;
  const day = typeof date === 'string' ? dayNumber(date) : null;
  if (typeof date !== 'string' || day === null) {
    return 'date is not a calendar day written YYYY-MM-DD';
  }
  return {
    table: { date, source: parsed.source, models: Object.fromEntries(entries) },
    day,
  };
}

/**
 * Reads the price file's text. Refuses a text that is not a table; a table with no entry for the key; a
 * rate anywhere in it that is not a finite number above zero; a date that is not a calendar day, or is
 * after today; and, when `maxAgeDays` is set, a date more than that many days ago. Days are whole UTC days:
 * a table dated today is never in the future, and one dated exactly `maxAgeDays` days ago is still inside.
 */
export function loadPriceTable(args: {
  readonly text: string; // the file's contents
  readonly key: string; // "provider:model"
  readonly now: Date;
  readonly maxAgeDays: number | null; // PRICE_TABLE_MAX_AGE_DAYS on the live lane; null on the replay lane
}): { readonly table: PriceTable; readonly prices: Prices } | { readonly refused: string } {
  const refuse = (reason: string): { readonly refused: string } => ({
    refused: `price table: ${reason}`,
  });
  const read = readTable(args.text);
  if (typeof read === 'string') return refuse(read);
  const { table, day } = read;
  const prices = Object.hasOwn(table.models, args.key) ? table.models[args.key] : undefined;
  if (prices === undefined) return refuse(`no entry for ${args.key}`);
  const age = Math.floor(args.now.getTime() / DAY_MS) - day;
  // Both limits are written so that an age or a limit that is not a number refuses the table.
  if (!(age >= 0)) return refuse(`date ${table.date} is after today`);
  if (args.maxAgeDays !== null && !(age <= args.maxAgeDays)) {
    return refuse(`date ${table.date} is more than ${args.maxAgeDays} days ago`);
  }
  return { table, prices };
}

export interface SpendMeter {
  /**
   * Before a request: holds its worst case. It is held only if the spend already settled, every hold and
   * this request's worst case stay within the cap; false means it is refused, and nothing is sent.
   */
  reserve(bucket: string, bodyBytes: number): boolean;
  /**
   * When an attempt ends, what it held is replaced by what it cost, and never by more than it held. With
   * usage and one request that is the usage; with usage and several requests, the usage and the worst case
   * of all but the one with the smallest worst case (which one reported it is not known, so this holds
   * whichever it was), capped at the worst case of all of them; with no usage, the worst case of every
   * request; with no request, nothing. Usage that cannot be true of the requests that were metered, and
   * any count at all when none was, settles at the worst case of every request (nothing, with no
   * request), and then throws a RunAbort.
   */
  settle(bucket: string, usage: Usage | null): void;
  /** Requests passed to the base fetch in the bucket; a refused request is not one of them. */
  requestsOf(bucket: string): number;
  refusedIn(bucket: string): boolean;
  /** What the bucket settled at: its measured cost, and the charge the cap counts. Zero before it settles. */
  costOf(bucket: string): Cost;
  readonly capUsd: number;
  readonly committedUsd: number;
  readonly heldUsd: number;
  readonly refused: boolean; // sticky: once true, the scheduler starts no new trial
}

interface Hold {
  readonly bytes: number;
  readonly usd: number;
}

interface Bucket {
  requests: number;
  refused: boolean;
  holds: Hold[]; // the requests the bucket has not settled
  measuredUsd: number;
  upperUsd: number;
}

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

// Why usage cannot be true of the requests that were metered (their body sizes); null when it can. With no
// request metered, any count is spend the meter never saw. Otherwise a count is true only between zero and
// its limit, so one that is negative or not a number is not.
function impossible(
  usage: Usage,
  bodies: readonly number[],
  maxOutputTokens: number,
): string | null {
  if (bodies.length === 0) {
    return usage.inputTokens === 0 && usage.outputTokens === 0
      ? null
      : `spend guard: usage was reported (${usage.inputTokens} input, ${usage.outputTokens} output tokens) but no request was metered`;
  }
  const largestBody = Math.max(...bodies);
  const within = (tokens: number, limit: number): boolean => tokens >= 0 && tokens <= limit;
  if (!within(usage.inputTokens, largestBody)) {
    return `spend guard: reported input tokens (${usage.inputTokens}) do not fit the largest request body (${largestBody} bytes)`;
  }
  if (!within(usage.outputTokens, maxOutputTokens)) {
    return `spend guard: reported output tokens (${usage.outputTokens}) do not fit the output limit (${maxOutputTokens})`;
  }
  return null;
}

export function createSpendMeter(args: {
  readonly capUsd: number;
  readonly prices: Prices;
  readonly maxOutputTokens: number; // MAX_OUTPUT_TOKENS, imported from the cli
}): SpendMeter {
  const { capUsd, prices, maxOutputTokens } = args;
  // The meter's own inputs are the caller's code, not user input, so one out of range is a bug. The rates
  // face the loader's own test, so the two never disagree about a table. Only input, cacheWrite and output
  // are in a worst case (the larger of the first two prices the input tokens), so a zero there can make the
  // bound too small; cacheRead is in none, and is refused for parity with the loader.
  for (const [name, value] of [
    ['capUsd', capUsd],
    ['maxOutputTokens', maxOutputTokens],
  ] as const) {
    if (!(Number.isFinite(value) && value >= 0)) {
      throw new Error(`createSpendMeter: ${name} is not a finite number of at least zero`);
    }
  }
  const checked = readPrices(prices);
  if ('bad' in checked) {
    throw new Error(`createSpendMeter: prices.${checked.bad} is not a finite number above zero`);
  }
  // Reported input tokens count cache writes and reads, so every bound prices them at the highest input rate.
  const upperInput = Math.max(prices.input, prices.cacheWrite);
  const usd = (inputTokens: number, inputRate: number, outputTokens: number): number =>
    (inputTokens * inputRate + outputTokens * prices.output) / PER_MILLION;
  const worstOf = (bytes: number): number => usd(bytes, upperInput, maxOutputTokens);

  const buckets = new Map<string, Bucket>();
  const bucketOf = (name: string): Bucket => {
    const found = buckets.get(name);
    if (found !== undefined) return found;
    const created: Bucket = { requests: 0, refused: false, holds: [], measuredUsd: 0, upperUsd: 0 };
    buckets.set(name, created);
    return created;
  };
  let committed = 0;
  let refused = false;
  // Summed afresh each time rather than kept as a running total, so a release leaves no rounding behind.
  const held = (): number =>
    sum([...buckets.values()].flatMap((bucket) => bucket.holds.map((hold) => hold.usd)));

  return {
    reserve(name, bodyBytes) {
      const bucket = bucketOf(name);
      const sized = Number.isSafeInteger(bodyBytes) && bodyBytes >= 0;
      const worst = worstOf(bodyBytes);
      // Accept only on a test that holds: a sum that is not a number fails it, and the request is refused.
      if (!(sized && committed + held() + worst <= capUsd)) {
        bucket.refused = true;
        refused = true;
        return false;
      }
      bucket.requests += 1;
      bucket.holds.push({ bytes: bodyBytes, usd: worst });
      return true;
    },
    settle(name, usage) {
      const bucket = bucketOf(name);
      // The holds are released first; a request made in this bucket after now is held for the rest of the run.
      const { holds } = bucket;
      bucket.holds = [];
      const worsts = holds.map((hold) => hold.usd);
      const bodies = holds.map((hold) => hold.bytes);
      const stop = usage === null ? null : impossible(usage, bodies, maxOutputTokens);
      const reserved = sum(worsts);
      let measured = 0;
      let upper = reserved;
      if (usage !== null && stop === null) {
        measured = usd(usage.inputTokens, prices.input, usage.outputTokens);
        const others = worsts.toSorted((a, b) => a - b).slice(1);
        // Each request costs at most its own worst case, so the charge never passes what the bucket held:
        // the committed spend and the holds that were within the cap stay within it after the settle.
        upper = Math.min(
          reserved,
          usd(usage.inputTokens, upperInput, usage.outputTokens) + sum(others),
        );
      }
      bucket.measuredUsd += measured;
      bucket.upperUsd += upper;
      committed += upper;
      if (stop !== null) throw new RunAbort(stop);
    },
    requestsOf: (name) => buckets.get(name)?.requests ?? 0,
    refusedIn: (name) => buckets.get(name)?.refused ?? false,
    costOf: (name) => ({
      measuredUsd: buckets.get(name)?.measuredUsd ?? 0,
      upperUsd: buckets.get(name)?.upperUsd ?? 0,
    }),
    capUsd,
    get committedUsd() {
      return committed;
    },
    get heldUsd() {
      return held();
    },
    get refused() {
      return refused;
    },
  };
}

/** Every request goes through here; it reads only the body's length, never a header. */
export function meteredFetch(base: FetchLike, meter: SpendMeter, bucket: () => string): FetchLike {
  return (input, init) => {
    const body = init?.body;
    // A body that is not a string has a size nobody can read here, and a Request object carries its body
    // out of sight: its size is taken as unbounded, and the meter refuses it.
    const bytes =
      typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : Number.POSITIVE_INFINITY;
    if (!meter.reserve(bucket(), bytes)) {
      // A plain Error, never a TypeError: the provider utilities retry a TypeError as a network failure.
      return Promise.reject(new Error('spend cap: request refused before sending'));
    }
    return base(input, init);
  };
}

/** One trial's view of the meter: `wrap` is the provider table's Meter, `hooks` are what runTrial calls. */
export function trialMeter(
  meter: SpendMeter,
  trialId: string,
): {
  readonly wrap: (base: FetchLike) => FetchLike;
  readonly hooks: AttemptHooks;
  /** This trial's cost so far, over its settled attempts: the row's `cost`. */
  readonly cost: () => Cost;
} {
  const bucketOf = (attempt: number): string => `${trialId}/${attempt}`;
  // A request made before any attempt starts is held in a bucket that never settles, never lost.
  let current = bucketOf(0);
  const settled = new Set<string>();
  return {
    wrap: (base) => meteredFetch(base, meter, () => current),
    hooks: {
      start: (attempt) => {
        current = bucketOf(attempt);
      },
      end: (attempt, usage) => {
        const name = bucketOf(attempt);
        // Listed before the settle: an attempt that ends in a runtime guard is still part of the cost.
        settled.add(name);
        meter.settle(name, usage);
        return { requests: meter.requestsOf(name), refused: meter.refusedIn(name) };
      },
    },
    cost: () => {
      const costs = [...settled].map((name) => meter.costOf(name));
      return {
        measuredUsd: sum(costs.map((cost) => cost.measuredUsd)),
        upperUsd: sum(costs.map((cost) => cost.upperUsd)),
      };
    },
  };
}
