import type { MinituiCatalog } from '@minitui/catalog';
import type { MiniAppSpec } from '@minitui/spec';
import type { GenerationCase } from '../harness/cases.js';
import type { CapabilityCause, CheckResult } from '../harness/row.js';
import type { StopKind } from '../harness/trial.js';
import { describedChecks } from './described.js';
import { sharedChecks } from './shared.js';
import { videoMergeChecks } from './video-merge.js';

export interface GradeInput {
  readonly testCase: GenerationCase;
  readonly stop: StopKind; // the trial's stop, for the shared `valid` check
  readonly attempts: number; // attempts the loop made, for `first-attempt-valid`
  readonly spec: MiniAppSpec | null; // the validated spec when stop is 'valid', else null; before the row stores it as JSON
  readonly caseDirectory: string; // absolute
  readonly catalog: MinituiCatalog;
}
export type Checker = (input: GradeInput) => readonly CheckResult[];

/** The grading every row is made under: 0 is the draft, so its rows can never pass for approved ones. */
export const GRADING_VERSION = 0;

/** Keyed by catalog id. A catalog with no entry fails the loader, never the run. */
export const CATALOG_CHECKERS: Readonly<Record<string, Checker>> = {
  'video-merge': videoMergeChecks,
};

/**
 * A trial's checks: the shared ones, the catalog's, then one per described element. A pure function of
 * the trial's outcome and the case; a trial without a validated spec carries the same names, failed.
 */
export function grade(input: GradeInput): readonly CheckResult[] {
  const checker = CATALOG_CHECKERS[input.testCase.catalog];
  if (checker === undefined) throw new Error('the case names a catalog with no checker');
  return [...sharedChecks(input), ...checker(input), ...describedChecks(input)];
}

/**
 * Why a capability case came out as it did, decided from the case before the result is read; null for a
 * regression case. Only `pass` and `model-error` read the outcome.
 */
export function capabilityCause(
  testCase: GenerationCase,
  catalog: MinituiCatalog,
  passAll: boolean,
): CapabilityCause | null {
  if (testCase.suite !== 'capability') return null;
  const { components, actions } = testCase.requires;
  if (components.some((name) => !catalog.componentNames.includes(name))) return 'missing-component';
  if (actions.some((name) => !catalog.actionNames.includes(name))) return 'missing-action';
  if (testCase.needsModelWrittenCode) return 'needs-model-written-code';
  return passAll ? 'pass' : 'model-error';
}
