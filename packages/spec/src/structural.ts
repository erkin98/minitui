import { validateSpec, autoFixSpec, formatSpecIssues, type SpecIssue } from '@json-render/core';
import type { Spec } from './spec-types.js';

// Re-export json-render's issue type verbatim (its `code` field is the adopted
// closed literal union — carried along whatever the pinned version defines).
export type { SpecIssue };

/** The adopted generate->autoFix->validate->reprompt ceiling. */
export const MAX_RETRIES = 5;

/** Thin pass-through to json-render's structural validator. */
export function validateStructure(spec: Spec): { valid: boolean; issues: SpecIssue[] } {
  return validateSpec(spec);
}

/**
 * Thin pass-through to json-render's autoFix; returns the new spec + fix
 * messages. The pinned `@json-render/core@0.19.0` `autoFixSpec` is
 * relocation-only (it moves a misplaced `visible`/`on`/`repeat`/`watch` out of
 * `props` to the element level) and never prunes content, so it is already
 * lossless — there is no lossy content-pruning to opt out of. That satisfies
 * the loop's policy that a launch-blocking validator must never silently DROP
 * data: a defect this fixer cannot losslessly repair stays an error and is
 * reprompted to the agent, never lossy-fixed-then-rendered.
 */
export function autoFixStructure(spec: Spec): { spec: Spec; fixes: string[] } {
  const { spec: fixed, fixes } = autoFixSpec(spec);
  return { spec: fixed, fixes };
}

/** Format structural errors for a repair prompt (json-render's AI formatter). */
export function formatStructuralIssues(issues: SpecIssue[]): string {
  return formatSpecIssues(issues);
}
