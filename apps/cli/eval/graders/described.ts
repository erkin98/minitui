import { toWireSpec, type MiniAppSpec } from '@minitui/spec';
import type { SpecElement } from '@minitui/types';
import type { DescribedElement } from '../harness/cases.js';
import type { CheckResult } from '../harness/row.js';
import type { GradeInput } from './index.js';
import { bindingsOf, checked, failedNoSpec, isRecord, pointerOf, resolveValue } from './shared.js';

// Check names are kebab-case, so the component name is lower-cased.
const nameOf = (entry: DescribedElement, index: number): string =>
  `described-${index + 1}-${entry.type.toLowerCase()}`;

const weight = (entry: DescribedElement): number =>
  (entry.label === null ? 0 : 1) +
  entry.options.length +
  (entry.bound ? 1 : 0) +
  (entry.pressAction === null ? 0 : 1);

// What a person reads as the element's label: its label prop, or a Text's own text.
function labelOf(element: SpecElement, state: Record<string, unknown>): string | undefined {
  const label = resolveValue(element.props.label ?? element.props.text, state);
  return typeof label === 'string' ? label : undefined;
}

function optionValues(element: SpecElement, state: Record<string, unknown>): readonly unknown[] {
  const options = resolveValue(element.props.options, state);
  return Array.isArray(options) ? options.map((o: unknown) => (isRecord(o) ? o.value : o)) : [];
}

function matches(
  element: SpecElement,
  entry: DescribedElement,
  spec: MiniAppSpec,
  presses: ReadonlySet<string>,
  key: string,
): boolean {
  if (element.type !== entry.type) return false;
  const label = labelOf(element, spec.state)?.toLowerCase();
  if (entry.label !== null && !(label ?? '').includes(entry.label.toLowerCase())) return false;
  const offered = optionValues(element, spec.state);
  if (!entry.options.every((value) => offered.includes(value))) return false;
  const bound = [element.props.value, element.props.items].some((v) => pointerOf(v) !== undefined);
  if (entry.bound && !bound) return false;
  return entry.pressAction === null || presses.has(`${key}\n${entry.pressAction}`);
}

/**
 * One check per described element. Entries are matched greedily, most constrained first, each to an
 * element no other entry took.
 */
// ponytail: greedy matching; a two-entry ambiguity can fail a spec a bipartite match would pass, upgrade if a case shows it.
export function describedChecks(input: GradeInput): readonly CheckResult[] {
  const entries = input.testCase.expect.described;
  const { spec } = input;
  if (spec === null) return entries.map((entry, i) => failedNoSpec(nameOf(entry, i)));

  const elements = Object.entries(toWireSpec(spec).elements);
  // `element key + action` for every press binding, so an entry can ask for its element's press action.
  const presses = new Set(
    bindingsOf(spec)
      .filter(({ event }) => event === 'press')
      .map(({ key, binding }) => `${key}\n${binding.action}`),
  );
  const taken = new Set<string>();
  const found = new Map<number, boolean>();
  const order = entries.map((entry, index) => ({ entry, index }));
  order.sort((a, b) => weight(b.entry) - weight(a.entry));
  for (const { entry, index } of order) {
    const hit = elements.find(
      ([key, element]) => !taken.has(key) && matches(element, entry, spec, presses, key),
    );
    if (hit !== undefined) taken.add(hit[0]);
    found.set(index, hit !== undefined);
  }
  return entries.map((entry, index) =>
    checked(nameOf(entry, index), found.get(index) === true, {
      pass: 'an element has the described type, label, options, binding and press action',
      fail: 'no free element has the described type, label, options, binding and press action',
    }),
  );
}
