import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evalMain } from '../../eval/main.js';
import {
  MODEL,
  RUN_ID,
  committedCase,
  rowsIn,
  spendingReplay,
  tempDirs,
  testDeps,
  writeCaseSet,
} from '../support/eval-run.js';

// The recommendation is made only for the run the rule was written for: the whole regression suite of the
// loaded case set, at three trials a case or more. Here the three regression cases below are that set.

const dirs = tempDirs();
afterAll(() => dirs.cleanup());

const THREE = ['merge-hand-run', 'merge-trip-days', 'merge-xyz-bare'].map(committedCase);

// A run of the three cases, and the one line of its report that carries the recommendation.
async function recommendationOf(flags: readonly string[]): Promise<string | undefined> {
  const dir = dirs.make();
  const path = writeCaseSet(dir, THREE);
  const out = join(dir, 'out');
  const code = await evalMain(
    ['--cases', path, '--out', out, '--arms', 'medium,high', ...flags],
    // every trial settles at about $0.60, so the replay lane's cap below holds all of them
    testDeps({ providers: spendingReplay({ inputTokens: 1, outputTokens: 60_000 }) }).deps,
  );
  expect(code).toBe(0);
  return readFileSync(join(out, RUN_ID, 'report.md'), 'utf8')
    .split('\n')
    .find((line) => line.startsWith('- Recommendation:'));
}

const REPLAY = ['--replay', '--provider', 'anthropic', '--model', MODEL, '--cap-usd', '12'];

describe('the size the rule was written for', () => {
  it('the whole set at one trial, as the pilot ran: not applied for its size, whatever the cap allows', async () => {
    expect(await recommendationOf([...REPLAY, '--trials', '1'])).toBe(
      '- Recommendation: not applied: not the pre-registered size (3 of 3 regression cases, k = 1). The figures above are descriptive.',
    );
  });

  it('two of the three regression cases at three trials: not the whole suite, so not applied', async () => {
    const only = ['--only', 'merge-hand-run,merge-trip-days'];
    expect(await recommendationOf([...REPLAY, '--trials', '3', ...only])).toBe(
      '- Recommendation: not applied: not the pre-registered size (2 of 3 regression cases, k = 3). The figures above are descriptive.',
    );
  });

  it('the control: all three at three trials is the size, so the report gives a recommendation', async () => {
    expect(await recommendationOf([...REPLAY, '--trials', '3'])).toMatch(
      /^- Recommendation: (send medium|keep the model’s own default)/,
    );
  });

  it('the dry lane is judged the same way', async () => {
    const dir = dirs.make();
    const out = join(dir, 'out');
    const args = ['--cases', writeCaseSet(dir, THREE), '--out', out, '--arms', 'medium,high'];
    expect(await evalMain([...args, '--dry-run', '--trials', '1'], testDeps().deps)).toBe(0);
    const report = readFileSync(join(out, RUN_ID, 'report.md'), 'utf8');
    expect(report).toContain('not the pre-registered size (3 of 3 regression cases, k = 1)');
    expect(rowsIn(join(out, RUN_ID))).toHaveLength(6);
  });
});
