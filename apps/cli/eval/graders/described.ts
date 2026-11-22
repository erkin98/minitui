import { getByPath, toWireSpec, type MiniAppSpec } from '@minitui/spec';
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
  (entry.pressAction === null ? 0 : 1) +
  (entry.showsState ? 1 : 0);

// The prop that holds what a person reads on the element, as written in the spec.
const textProp = (element: SpecElement): unknown => element.props.label ?? element.props.text;

// json-render resolves a prop value by the first marker it finds, in this order (@json-render/core 0.19.0,
// dist/index.mjs, resolvePropValue): `$state` (lines 276-278), `$item` (279-282), `$index` (283-285),
// `$bindState` (286-288), `$bindItem` (289-293), a complete `$cond` (294-297), `$computed` (298-316; the
// catalog refuses it, packages/catalog/src/validate/semantic.ts:64-73), then `$template` (317-333). The two
// readers below keep that order, so a value that carries several markers is read as the first one and what
// sits beside it is never read.

// A conditional to json-render: `$cond` with both of its branches (isCondExpression, lines 253-255). With
// a branch missing it is a plain object.
const isCond = (value: Readonly<Record<string, unknown>>): boolean =>
  '$cond' in value && '$then' in value && '$else' in value;

// A template as json-render fills it (resolvePropValue, lines 317-333): each `${...}` hole (the pattern,
// line 319, needs a name between the braces) reads the state at its path, an absolute path as written
// (321-324) and a bare one as `/name` (329-330), and a value that is missing reads as an empty string. Both
// paths go to getByPath as written: it reads a path with or without its leading slash (parseJsonPointer,
// chunk-AFLK3Q4T.mjs 34-37). The repeat item that a bare hole reads first inside a repeat (325-328) is not
// mirrored: no item is known here.
function fillTemplate(template: string, state: Record<string, unknown>): string {
  return template.replace(/\$\{([^}]+)\}/g, (_hole, path: string) => {
    const read = getByPath(state, path);
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- mirrors json-render's String(); an object reads [object Object]
    return read === null || read === undefined ? '' : String(read);
  });
}

// What a `$state` or `$bindState` marker reads: the state at its pointer, a text only when that is a string.
function stateTexts(pointer: string, state: Record<string, unknown>): readonly string[] {
  const read = getByPath(state, pointer);
  return typeof read === 'string' ? [read] : [];
}

// Every text a person could read for a prop value, in the order above. A string is itself. A `$state` or
// `$bindState` marker reads the state. An `$item`, `$index` or `$bindItem` marker reads the repeat the
// element is in, which the grader does not know, so it has no text. A complete `$cond` shows the branch it
// picks when it renders, so either branch may be what is read. A `$template` is its text with the holes
// filled. Anything else is no label.
function textsOf(value: unknown, state: Record<string, unknown>): readonly string[] {
  if (typeof value === 'string') return [value];
  if (!isRecord(value)) return [];
  if (typeof value.$state === 'string') return stateTexts(value.$state, state);
  if (typeof value.$item === 'string' || value.$index === true) return [];
  if (typeof value.$bindState === 'string') return stateTexts(value.$bindState, state);
  if (typeof value.$bindItem === 'string') return [];
  if (isCond(value)) return [...textsOf(value.$then, state), ...textsOf(value.$else, state)];
  return typeof value.$template === 'string' ? [fillTemplate(value.$template, state)] : [];
}

// Whether what a person reads as the element's label (its label prop, or a Text's own text) holds the
// entry's label part, in any case. An entry with no label part asks nothing.
function readsLabel(
  element: SpecElement,
  entry: DescribedElement,
  state: Record<string, unknown>,
): boolean {
  if (entry.label === null) return true;
  const part = entry.label.toLowerCase();
  return textsOf(textProp(element), state).some((text) => text.toLowerCase().includes(part));
}

// Whether the renderer reads state to resolve a prop value, in the order above: a `$state`, `$item`,
// `$bindState` or `$bindItem` marker does (a repeat item is read from state); `$index` is a position, a
// number and not state; a complete `$cond` does when its chosen branch does, so two fixed strings do not,
// whatever the condition reads; a `$template` does when it has a `${...}` hole, bare or absolute (its
// pattern, line 319, needs a name between the braces, so an empty `${}` stays plain text).
function showsState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.$state === 'string' || typeof value.$item === 'string') return true;
  if (value.$index === true) return false;
  if (typeof value.$bindState === 'string' || typeof value.$bindItem === 'string') return true;
  if (isCond(value)) return showsState(value.$then) || showsState(value.$else);
  return typeof value.$template === 'string' && /\$\{[^}]+\}/.test(value.$template);
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
  if (!readsLabel(element, entry, spec.state)) return false;
  const offered = optionValues(element, spec.state);
  if (!entry.options.every((value) => offered.includes(value))) return false;
  const bound = [element.props.value, element.props.items].some((v) => pointerOf(v) !== undefined);
  if (entry.bound && !bound) return false;
  if (entry.showsState && !showsState(textProp(element))) return false;
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
