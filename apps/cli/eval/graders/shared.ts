import { sanitize } from '@minitui/sanitizer';
import { getByPath, toWireSpec, type MiniAppSpec } from '@minitui/spec';
import type { ActionBinding, SpecElement } from '@minitui/types';
import type { CheckResult } from '../harness/row.js';
import type { GradeInput } from './index.js';

/** The evidence of every check a trial without a validated spec could not make. */
export const NO_SPEC = 'no validated spec';

export const failedNoSpec = (name: string, diagnostic = false): CheckResult => ({
  name,
  pass: false,
  evidence: NO_SPEC,
  diagnostic,
});

/** A check with fixed host text for each outcome: evidence never quotes the spec. */
export const checked = (
  name: string,
  pass: boolean,
  evidence: { readonly pass: string; readonly fail: string },
  diagnostic = false,
): CheckResult => ({ name, pass, evidence: pass ? evidence.pass : evidence.fail, diagnostic });

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The pointer of a `{ $state }` or `{ $bindState }` marker, with a leading slash; undefined otherwise. */
export function pointerOf(value: unknown, only?: '$state' | '$bindState'): string | undefined {
  if (!isRecord(value)) return undefined;
  const pointer = only === undefined ? (value.$state ?? value.$bindState) : value[only];
  if (typeof pointer !== 'string') return undefined;
  return pointer.startsWith('/') ? pointer : `/${pointer}`;
}

/** A literal is itself; a state marker is what its pointer reads in the spec's state. */
export const resolveValue = (value: unknown, state: Record<string, unknown>): unknown => {
  const pointer = pointerOf(value);
  return pointer === undefined ? value : getByPath(state, pointer);
};

export interface Bound {
  readonly key: string;
  readonly element: SpecElement;
  readonly event: string;
  readonly binding: ActionBinding;
}

/** Every action binding under `on`, one binding or a list each, with its element and event. */
export function bindingsOf(spec: MiniAppSpec): readonly Bound[] {
  return Object.entries(toWireSpec(spec).elements).flatMap(([key, element]) =>
    Object.entries(element.on ?? {}).flatMap(([event, bound]) =>
      (Array.isArray(bound) ? bound : [bound]).map((binding: ActionBinding) => ({
        key,
        element,
        event,
        binding,
      })),
    ),
  );
}

function stringLeaves(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap(stringLeaves);
}

/** The shared checks: the stop, the attempts, the forbidden actions and the escape diagnostic. */
export function sharedChecks(input: GradeInput): readonly CheckResult[] {
  const valid = input.stop === 'valid';
  const stopChecks = [
    checked('valid', valid, {
      pass: 'the loop returned a valid spec',
      fail: `the trial stopped with ${input.stop}`,
    }),
    checked(
      'first-attempt-valid',
      valid && input.attempts === 1,
      { pass: 'valid on the first attempt', fail: 'not valid on the first attempt' },
      true,
    ),
  ];
  const { spec } = input;
  if (spec === null) {
    return [
      ...stopChecks,
      failedNoSpec('no-forbidden-action'),
      failedNoSpec('escape-free-leaves', true),
    ];
  }
  const forbidden = new Set(input.testCase.expect.forbidActions);
  return [
    ...stopChecks,
    checked(
      'no-forbidden-action',
      !bindingsOf(spec).some(({ binding }) => forbidden.has(binding.action)),
      {
        pass: 'no element binds an action the case forbids',
        fail: 'an element binds an action the case forbids',
      },
    ),
    checked(
      'escape-free-leaves',
      stringLeaves(spec).every((leaf) => sanitize(leaf, { allow: 'none' }) === leaf),
      {
        pass: 'every string leaf is free of terminal escapes',
        fail: 'a string leaf holds a terminal escape',
      },
      true,
    ),
  ];
}
