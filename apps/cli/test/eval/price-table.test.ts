import { describe, it, expect } from 'vitest';
import { PRICE_TABLE_MAX_AGE_DAYS, loadPriceTable, type Prices } from '../../eval/harness/spend.js';

// A frozen day for every loader row: noon on 1 December 2026.
const NOW = new Date('2026-12-01T12:00:00Z');
const KEY = 'fixture:model-a';
const RATES = { input: 2, cacheWrite: 4, cacheRead: 0.1, output: 10 };
const SOURCE = 'https://prices.example.test/';
const daysBefore = (days: number): string =>
  new Date(NOW.getTime() - days * 86_400_000).toISOString().slice(0, 10);

// The file's text, with each rate and the date as raw JSON, so a row can write what JSON.stringify cannot.
function tableText(
  over: {
    readonly date?: string;
    readonly rates?: Partial<Record<keyof Prices, string>>;
    readonly otherModel?: string;
  } = {},
): string {
  const r = { input: '2', cacheWrite: '4', cacheRead: '0.1', output: '10', ...over.rates };
  const entry = (rates: typeof r): string =>
    `{ "input": ${rates.input}, "cacheWrite": ${rates.cacheWrite}, "cacheRead": ${rates.cacheRead}, "output": ${rates.output} }`;
  const models = [`"${KEY}": ${entry(r)}`];
  if (over.otherModel !== undefined) {
    models.push(`"fixture:model-b": ${entry({ ...r, input: over.otherModel })}`);
  }
  return `{ "date": ${over.date ?? JSON.stringify(daysBefore(1))}, "source": "${SOURCE}", "models": { ${models.join(', ')} } }`;
}

function load(
  over: {
    readonly text?: string;
    readonly key?: string;
    readonly now?: Date;
    readonly maxAgeDays?: number | null;
  } = {},
): ReturnType<typeof loadPriceTable> {
  return loadPriceTable({
    text: over.text ?? tableText(),
    key: over.key ?? KEY,
    now: over.now ?? NOW,
    maxAgeDays: over.maxAgeDays === undefined ? PRICE_TABLE_MAX_AGE_DAYS : over.maxAgeDays,
  });
}

const refusalOf = (result: ReturnType<typeof loadPriceTable>): string | null =>
  'refused' in result ? result.refused : null;

describe('loadPriceTable: what it accepts', () => {
  it('returns the table and the requested entry', () => {
    expect(load()).toEqual({
      table: { date: daysBefore(1), source: SOURCE, models: { [KEY]: RATES } },
      prices: RATES,
    });
  });

  it('the live lane uses a limit of 30 days', () => {
    expect(PRICE_TABLE_MAX_AGE_DAYS).toBe(30);
  });
});

describe('loadPriceTable: what it refuses', () => {
  it.each([
    ['text that is not JSON', 'not json at all', /not valid JSON/],
    ['a JSON array', '[1, 2]', /expected an object/],
    [
      'a table with no models',
      `{ "date": "2026-11-30", "source": "${SOURCE}" }`,
      /expected an object/,
    ],
    ['a table with no source', `{ "date": "2026-11-30", "models": {} }`, /expected an object/],
  ])('%s', (_what, text, reason) => {
    expect(refusalOf(load({ text }))).toMatch(reason);
    expect(refusalOf(load())).toBeNull(); // the control: a whole table
  });

  it('a table with no entry for the requested model', () => {
    expect(refusalOf(load({ key: 'fixture:model-b' }))).toMatch(/no entry for fixture:model-b/);
    expect(refusalOf(load({ key: KEY }))).toBeNull();
  });

  it('a key that only the object prototype has is no entry', () => {
    expect(refusalOf(load({ key: 'toString' }))).toMatch(/no entry for toString/);
    expect(refusalOf(load({ key: KEY }))).toBeNull();
  });

  it.each(['input', 'cacheWrite', 'cacheRead', 'output'] as const)(
    'a zero %s rate: the planted zero-price table is refused, and accepted with the rate set',
    (field) => {
      const planted = load({ text: tableText({ rates: { [field]: '0' } }) });
      expect(refusalOf(planted)).toMatch(
        new RegExp(`${KEY}.${field} is not a finite number above zero`),
      );
      expect(refusalOf(load({ text: tableText({ rates: { [field]: '1' } }) }))).toBeNull();
    },
  );

  it.each([
    ['negative', '-2'],
    ['a string', '"2"'],
    ['null', 'null'],
    ['not finite (1e999 reads as infinity)', '1e999'],
  ])('a rate that is %s', (_what, raw) => {
    expect(refusalOf(load({ text: tableText({ rates: { input: raw } }) }))).toMatch(
      /input is not a finite number above zero/,
    );
    expect(refusalOf(load({ text: tableText({ rates: { input: '2' } }) }))).toBeNull();
  });

  it('a bad rate in an entry that is not the requested one', () => {
    expect(refusalOf(load({ text: tableText({ otherModel: '0' }) }))).toMatch(/model-b.input/);
    expect(refusalOf(load({ text: tableText({ otherModel: '3' }) }))).toBeNull();
  });

  it.each([
    ['month 13', '"2026-13-01"'],
    ['a day the month does not have', '"2026-02-30"'],
    ['no leading zeros', '"2026-1-5"'],
    ['no dashes', '"20261130"'],
    ['a time as well', '"2026-11-30T00:00:00Z"'],
    ['a number', '20261130'],
    ['empty', '""'],
    ['only a year', '"2026"'],
    ['only a month', '"2026-11"'],
  ])('a date with %s', (_what, raw) => {
    expect(refusalOf(load({ text: tableText({ date: raw }) }))).toMatch(
      /date is not a calendar day written YYYY-MM-DD/,
    );
    expect(refusalOf(load({ text: tableText({ date: '"2026-11-30"' }) }))).toBeNull();
  });

  it('a date after today; today itself is accepted, at any hour of it', () => {
    expect(refusalOf(load({ text: tableText({ date: JSON.stringify(daysBefore(-1)) }) }))).toMatch(
      /date 2026-12-02 is after today/,
    );
    const today = tableText({ date: JSON.stringify(daysBefore(0)) });
    expect(refusalOf(load({ text: today }))).toBeNull();
    expect(refusalOf(load({ text: today, now: new Date('2026-12-01T00:00:00.000Z') }))).toBeNull();
    expect(refusalOf(load({ text: today, now: new Date('2026-12-01T23:59:59.999Z') }))).toBeNull();
    expect(refusalOf(load({ text: today, now: new Date('2026-11-30T23:59:59.999Z') }))).toMatch(
      /after today/,
    );
  });

  it('with the maximum age: one day past it is refused, and the last day inside it is accepted', () => {
    const past = tableText({ date: JSON.stringify(daysBefore(PRICE_TABLE_MAX_AGE_DAYS + 1)) });
    const limit = tableText({ date: JSON.stringify(daysBefore(PRICE_TABLE_MAX_AGE_DAYS)) });
    const inside = tableText({ date: JSON.stringify(daysBefore(PRICE_TABLE_MAX_AGE_DAYS - 1)) });
    expect(refusalOf(load({ text: past }))).toMatch(/date 2026-10-31 is more than 30 days ago/);
    expect(refusalOf(load({ text: limit }))).toBeNull(); // exactly 30 days is not more than 30
    expect(refusalOf(load({ text: inside }))).toBeNull();
  });

  it('with no maximum age the date is not checked for age; the same table is refused with one', () => {
    const old = tableText({ date: '"2016-01-01"' });
    expect(refusalOf(load({ text: old, maxAgeDays: null }))).toBeNull();
    expect(refusalOf(load({ text: old, maxAgeDays: 30 }))).toMatch(/days ago/);
  });

  it('a maximum age that is not a number, and a `now` that is not a date, accept nothing', () => {
    expect(refusalOf(load({ maxAgeDays: Number.NaN }))).toMatch(/days ago/);
    expect(refusalOf(load({ now: new Date(Number.NaN) }))).not.toBeNull();
    expect(refusalOf(load({ maxAgeDays: 30, now: NOW }))).toBeNull(); // the control
  });
});
