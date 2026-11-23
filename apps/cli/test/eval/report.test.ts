import { describe, expect, it } from 'vitest';
import { renderReport, type ReportMeta } from '../../eval/harness/report.js';
import type { EvalRow } from '../../eval/harness/row.js';
import { excludedOne, ids, pairedCase, range } from '../support/eval-stats.js';

// The report's wording where a run is not the size the decision rule was written for, where it counts
// its cases against the ones it selected, and where it names a column. The figures themselves are worked
// out in stats.test.ts.

const META: ReportMeta = {
  runId: '20261120T000000Z-0a1b2c3d',
  lane: 'replay',
  provider: 'p',
  model: 'm',
  caseSetVersion: 1,
  caseSetStatus: 'draft',
  gradingVersion: 0,
  arms: ['medium', 'high'],
  trials: 3,
  concurrency: 1,
  regressionCases: ids(10),
  loadedRegressionCases: 10,
};
const meta = (over: Partial<ReportMeta> = {}): ReportMeta => ({ ...META, ...over });

// cases c1 to c<count>, every trial of both arms passing
const passing = (count: number): EvalRow[] =>
  range(count).flatMap((n) => pairedCase(n, { medium: 3, high: 3 }));

const SIZE_LINE = (selected: number, loaded: number, k: number): string =>
  `- Recommendation: not applied: not the pre-registered size (${selected} of ${loaded} regression cases, k = ${k}). The figures above are descriptive.`;
const RECOMMENDATION = /Recommendation: (send medium|keep the model’s own default)/;

describe('the report of a run that is not the size the rule was written for', () => {
  it('the pilot, 4 of the 30 regression cases at one trial: not applied for its size, the figures kept', () => {
    const text = renderReport(
      passing(4),
      meta({ trials: 1, regressionCases: ids(4), loadedRegressionCases: 30 }),
    );
    expect(text).toContain(SIZE_LINE(4, 30, 1));
    expect(text).not.toMatch(RECOMMENDATION);
    // the numbers stay, as descriptive
    expect(text).toContain('- Condition 1, non-inferior:');
    expect(text).toContain('- Condition 2, cheaper:');
    expect(text).toContain('- McNemar exact on pass^1:');
  });

  it('the control: the whole suite at three trials is applied, with no size line', () => {
    const text = renderReport(passing(10), META);
    expect(text).toMatch(RECOMMENDATION);
    expect(text).not.toContain('not applied');
  });

  it('9 of the 10 regression cases at three trials: not the whole suite', () => {
    const text = renderReport(passing(9), meta({ regressionCases: ids(9) }));
    expect(text).toContain(SIZE_LINE(9, 10, 3));
    expect(text).not.toMatch(RECOMMENDATION);
  });

  it('the whole suite at two trials: not applied for its size', () => {
    const text = renderReport(passing(10), meta({ trials: 2 }));
    expect(text).toContain(SIZE_LINE(10, 10, 2));
  });

  it('a short run that also lost cases: the size is the reason given, not the excluded share', () => {
    // 4 of the 30 selected, and 2 of them a trial short: both conditions fail
    const rows = [...passing(2), ...excludedOne(3), ...excludedOne(4)];
    const text = renderReport(rows, meta({ regressionCases: ids(4), loadedRegressionCases: 30 }));
    expect(text).toContain(SIZE_LINE(4, 30, 3));
    expect(text).toContain('- 2 of 4 regression cases left the paired comparison');
    expect(text).not.toContain('(more than 10.0%) left the paired comparison');
  });
});

describe('the per-case columns are named for the run’s k', () => {
  it.each([1, 2, 3])(
    'k = %i: pass^k in the headline, the per-case table and the McNemar line only',
    (k) => {
      const text = renderReport(passing(10), meta({ trials: k }));
      expect(text).toContain(`|pass-all|pass^${k}|mean per-case pass-all|`);
      expect(text).toContain(`|effort-medium pass-all|effort-medium pass^${k}|`);
      expect(text).toContain(`- McNemar exact on pass^${k}:`);
      expect(text).toContain(`pass^${k} (Wilson over cases)`);
      for (const other of [1, 2, 3].filter((n) => n !== k)) {
        expect(text).not.toContain(`pass^${other}`);
      }
    },
  );
});

describe('the report counts its cases against the ones it selected', () => {
  // c1 to c6 ran whole in both arms; c7 is a trial short in effort-high; c8 to c10 never started. A
  // capability case that ran whole is no part of either count.
  const rows: EvalRow[] = [
    ...passing(6),
    ...excludedOne(7),
    ...pairedCase(1, { medium: 3, high: 3 }).map(
      (r): EvalRow => ({
        ...r,
        caseId: 'k1',
        suite: 'capability',
      }),
    ),
  ];
  const text = renderReport(rows, META);

  it('the headline says how many of the selected regression cases have all k outcome trials, per arm', () => {
    expect(text).toContain(
      'Regression cases with all 3 outcome trials: effort-medium 7 of 10 selected regression cases; effort-high 6 of 10 selected regression cases.',
    );
  });

  it('the first-build section says it too', () => {
    expect(text).toContain(
      'effort-high, regression suite, 6 of 10 selected regression cases with all 3 outcome trials; per-case means with their 95% t intervals.',
    );
  });

  it('a run that selected no regression case prints no such line', () => {
    const capabilityOnly = rows
      .filter((r) => r.suite === 'capability')
      .map((r): EvalRow => ({ ...r, caseId: 'k1' }));
    const bare = renderReport(
      capabilityOnly,
      meta({ regressionCases: [], loadedRegressionCases: 0 }),
    );
    expect(bare).not.toContain('Regression cases with all');
    expect(bare).toContain('No effort-high regression trials in this run.');
  });
});

describe('the report’s words', () => {
  it('the cost table names its mean as over every outcome trial', () => {
    const text = renderReport(passing(10), META);
    expect(text).toContain(
      '|arm|trials|measured total|accounted total|mean measured per outcome trial (all)|mean attempts|mean seconds|max seconds|',
    );
  });

  it.each([
    [1, 'fewer than 1 outcome trial in an arm'],
    [3, 'fewer than 3 outcome trials in an arm'],
  ])('k = %i: "%s"', (k, words) => {
    expect(renderReport(passing(10), meta({ trials: k }))).toContain(`(${words})`);
  });
});
