import {
  validateSpec,
  autoFixSpec,
  formatSpecIssues,
  VisibilityConditionSchema,
  type SpecIssue,
} from '@json-render/core';
import { checkElementTree, type ElementTreeIssue } from '@minitui/catalog';
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

// The keys the adopted fixer moves out of `props` to the element level.
const RELOCATED_KEYS = ['visible', 'on', 'repeat', 'watch'] as const;

const keyAtBothLevels = (spec: Spec): boolean =>
  Object.values(spec.elements).some((element) =>
    RELOCATED_KEYS.some((key) => element.props?.[key] !== undefined && element[key] !== undefined),
  );

/**
 * json-render's autoFix, which moves a misplaced `visible`/`on`/`repeat`/`watch` out of `props` to the
 * element level and never prunes anything else. It is lossless EXCEPT when a key sits at both levels: it
 * then overwrites the element-level value with the one from `props`. So when any element carries one of
 * those keys at both levels nothing is fixed (the spec comes back as given, with no fixes) and the adopted
 * validator's own `*_in_props` error reaches the model; no value is lost and no fixer of our own is
 * written. The loop's policy holds: a launch-blocking validator never silently DROPS data.
 */
export function autoFixStructure(spec: Spec): { spec: Spec; fixes: string[] } {
  if (keyAtBothLevels(spec)) return { spec, fixes: [] };
  const { spec: fixed, fixes } = autoFixSpec(spec);
  return { spec: fixed, fixes };
}

/** Format structural errors for a repair prompt (json-render's AI formatter). */
export function formatStructuralIssues(issues: SpecIssue[]): string {
  return formatSpecIssues(issues);
}

const TREE_CODE: Readonly<Record<ElementTreeIssue['code'], SpecIssue['code']>> = {
  'missing-root': 'root_not_found',
  'missing-child': 'missing_child',
  'not-a-tree': 'empty_spec',
  'too-deep': 'empty_spec',
};

/**
 * The tree rule of the catalog package as structural issues: every element is reached once from the
 * root, no deeper than the catalog's bound. It looks names up as own keys, which the adopted validation
 * does not (a root named `constructor` passes that one). The message and the element key are the
 * helper's own. Kept out of the package barrel.
 */
export function validateTree(spec: Spec): SpecIssue[] {
  return checkElementTree({ root: spec.root, elements: spec.elements }).map((issue) => ({
    severity: 'error',
    code: TREE_CODE[issue.code],
    message: issue.message,
    elementKey: issue.elementKey,
  }));
}

// One message for the whole class: it holds nothing the model wrote.
const CONDITION_MESSAGE =
  'a visible value or a $cond condition is not a valid condition; write true, false, a test such as ' +
  '{"$state": "/path", "eq": value}, a list of tests, or {"$and": [...]} / {"$or": [...]}';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validCondition = (condition: unknown): boolean =>
  VisibilityConditionSchema.safeParse(condition).success;

// A $cond record is complete when it has all of $cond, $then and $else; its condition is the $cond value.
function hasBadCondition(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasBadCondition);
  if (!isRecord(value)) return false;
  if ('$cond' in value && '$then' in value && '$else' in value && !validCondition(value.$cond)) {
    return true;
  }
  return Object.values(value).some(hasBadCondition);
}

// A binding is {action, params}; `on` and `watch` hold one binding or a list of them per key.
function hasBadBindingCondition(bindings: unknown): boolean {
  if (!isRecord(bindings)) return false;
  return Object.values(bindings).some((one) =>
    (Array.isArray(one) ? one : [one]).some(
      (binding) => isRecord(binding) && hasBadCondition(binding.params),
    ),
  );
}

function elementHasBadCondition(element: unknown): boolean {
  if (!isRecord(element)) return false;
  return (
    (element.visible !== undefined && !validCondition(element.visible)) ||
    hasBadCondition(element.props) ||
    hasBadBindingCondition(element.on) ||
    hasBadBindingCondition(element.watch)
  );
}

/**
 * The condition grammar. An element's `visible` and every complete `$cond` record found in its props
 * and in the params of its bindings are checked with the adopted `VisibilityConditionSchema`. Pointers
 * are not resolved against state: a state action may create the key later. Returns at most one issue, the
 * fixed message of the class. Kept out of the package barrel.
 */
export function validateConditions(spec: Spec): SpecIssue[] {
  return Object.values(spec.elements).some(elementHasBadCondition)
    ? [{ severity: 'error', code: 'empty_spec', message: CONDITION_MESSAGE }]
    : [];
}
