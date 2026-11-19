import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { toWireSpec } from '@minitui/spec';
import type { CheckResult } from '../harness/row.js';
import type { GradeInput } from './index.js';
import { bindingsOf, checked, failedNoSpec, isRecord, pointerOf, resolveValue } from './shared.js';

const EDITORS: Readonly<Record<string, string>> = { FilePicker: 'value', OrderList: 'items' };

// The file name a path names in the case directory, or null. A `..` segment is refused outright: the
// kernel follows it through what is on disk, so no reading of the text alone can say where it leads.
function nameIn(caseDirectory: string, value: unknown): string | null {
  if (typeof value !== 'string' || !isAbsolute(value)) return null;
  if (value.split(sep).includes('..')) return null;
  const full = resolve(value);
  return dirname(full) === caseDirectory ? basename(full) : null;
}

const sameItems = (a: readonly (string | null)[], b: readonly string[], ordered: boolean) =>
  a.length === b.length &&
  (ordered ? a.every((x, i) => x === b[i]) : [...a].sort().join('\n') === [...b].sort().join('\n'));

/** The merge checks, run when the case sets `expect.merge`. */
export function videoMergeChecks(input: GradeInput): readonly CheckResult[] {
  const merge = input.testCase.expect.merge;
  if (merge === null) return [];
  const names = ['merge-on-press', 'inputs-match', 'output-match', 'codec-acceptable'];
  if (merge.editableInputs) names.push('inputs-editable');
  const { spec } = input;
  if (spec === null) return names.map((name) => failedNoSpec(name));

  const all = bindingsOf(spec);
  // Every merge the app can run must be right, so each check reads all of them; none fails them all.
  const merges = all.filter(({ binding }) => binding.action === 'merge');
  const params = merges.map(({ binding }) => (isRecord(binding.params) ? binding.params : {}));
  const each = (test: (p: Readonly<Record<string, unknown>>) => boolean) =>
    params.length > 0 && params.every(test);
  const read = (p: Readonly<Record<string, unknown>>, key: string) =>
    resolveValue(p[key], spec.state);
  const dir = resolve(input.caseDirectory);

  const inputsMatch = each((p) => {
    const inputs = read(p, 'inputs');
    if (!Array.isArray(inputs)) return false;
    return sameItems(
      inputs.map((path: unknown) => nameIn(dir, path)),
      merge.inputs,
      merge.ordered,
    );
  });
  const outputMatch = each((p) => {
    const name = nameIn(dir, read(p, 'output'));
    return name !== null && (merge.output === null || name === merge.output);
  });
  const codecAcceptable = each((p) => {
    const codec = read(p, 'codec');
    // No codec cue: the valid spec's codec already passed the host's own list, so any codec is right.
    return typeof codec === 'string' && (merge.codecs.length === 0 || merge.codecs.includes(codec));
  });
  // An editor binds two-way the pointer the merge reads, or, a picker each, every item under it.
  const editors = Object.values(toWireSpec(spec).elements).flatMap((element) => {
    const prop = EDITORS[element.type];
    const pointer = prop === undefined ? undefined : pointerOf(element.props[prop], '$bindState');
    return pointer === undefined ? [] : [pointer];
  });
  const inputsEditable = each((p) => {
    const pointer = pointerOf(p.inputs);
    const inputs = read(p, 'inputs');
    if (pointer === undefined || !Array.isArray(inputs) || inputs.length === 0) return false;
    return editors.includes(pointer) || inputs.every((_, i) => editors.includes(`${pointer}/${i}`));
  });

  const results = [
    checked(
      'merge-on-press',
      merges.some(({ element, event }) => element.type === 'Button' && event === 'press'),
      { pass: 'a Button runs merge on press', fail: 'no Button runs merge on press' },
    ),
    checked('inputs-match', inputsMatch, {
      pass: 'the merge inputs are the named files of the case directory',
      fail: 'the merge inputs are not the named files of the case directory, as asked',
    }),
    checked('output-match', outputMatch, {
      pass: 'the merge output is the asked file in the case directory',
      fail: 'the merge output is not the asked file in the case directory',
    }),
    checked('codec-acceptable', codecAcceptable, {
      pass: 'the merge codec is one the case accepts',
      fail: 'the merge codec is not one the case accepts',
    }),
  ];
  if (!merge.editableInputs) return results;
  return [
    ...results,
    checked('inputs-editable', inputsEditable, {
      pass: 'a FilePicker or OrderList binds the merge inputs two-way',
      fail: 'no FilePicker or OrderList binds the merge inputs two-way',
    }),
  ];
}
