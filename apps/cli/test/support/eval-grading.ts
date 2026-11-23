import { videoMergeCatalog } from '@minitui/catalog';
import { composeValidation, type MiniAppSpec } from '@minitui/spec';
import { grade } from '../../eval/graders/index.js';
import {
  renderPatchText,
  type DescribedElement,
  type GenerationCase,
} from '../../eval/harness/cases.js';
import type { CheckResult } from '../../eval/harness/row.js';
import { fixedCapabilities } from '../../eval/harness/scripted.js';
import type { StopKind } from '../../eval/harness/trial.js';

// What the grader tests share: apps written as patch lines, the real validation loop over them, and the
// grading of a spec against a case.

// Every codec a reference or a health row names: the semantic stage checks the codec against this list.
// libaom-av1 is named by no case: a working encoder outside every case's list.
const CODECS = ['h264', 'libx264', 'hevc', 'libx265', 'mpeg4', 'vp9', 'libvpx-vp9', 'libaom-av1'];

/** The case directory a row grades in, unless it names another. */
export const DIR = '/run/c01';

export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

// The patch lines of an app, paths behind the placeholder, as a reference file holds them.
export function app(
  elements: Record<string, Json>,
  state: Record<string, Json>,
  root = 'main',
): string {
  const lines = [
    { op: 'add', path: '/root', value: root },
    ...Object.entries(elements).map(([key, value]) => ({
      op: 'add',
      path: `/elements/${key}`,
      value,
    })),
    { op: 'add', path: '/state', value: state },
  ];
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

async function* once(text: string): AsyncIterable<string> {
  yield text;
}

/** The real loop over a reply replayed on every request: the spec, or null, and the passes it made. */
export async function replay(
  text: string,
): Promise<{ spec: MiniAppSpec | null; attempts: number }> {
  let attempts = 1;
  const result = await composeValidation({
    stream: once(text),
    catalog: videoMergeCatalog,
    capabilities: fixedCapabilities(CODECS),
    regenerate: () => {
      attempts += 1;
      return once(text);
    },
  });
  return { spec: result.ok ? result.spec : null, attempts };
}

export async function validated(text: string, dir = DIR): Promise<MiniAppSpec> {
  const { spec } = await replay(renderPatchText(text, dir));
  if (spec === null) throw new Error('the health spec did not validate');
  return spec;
}

export const run = (
  testCase: GenerationCase,
  spec: MiniAppSpec | null,
  over: { stop?: StopKind; attempts?: number; dir?: string } = {},
): readonly CheckResult[] =>
  grade({
    testCase,
    stop: over.stop ?? (spec === null ? 'exhausted' : 'valid'),
    attempts: over.attempts ?? 1,
    spec,
    caseDirectory: over.dir ?? DIR,
    catalog: videoMergeCatalog,
  });

export const result = (checks: readonly CheckResult[], name: string): CheckResult => {
  const found = checks.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no check ${name}`);
  return found;
};

export const failingNames = (checks: readonly CheckResult[]): string[] =>
  checks.filter((c) => !c.pass).map((c) => c.name);

type PatchLine = { readonly path: string; readonly value: Record<string, unknown> };

// A reference with each of its patch lines passed through `edit`: parsed, changed, written again.
export function editPatch(patch: string, edit: (line: PatchLine) => PatchLine): string {
  const lines = patch
    .split('\n')
    .filter((text) => text !== '')
    .map((text) => {
      const parsed: PatchLine = JSON.parse(text);
      return edit(parsed);
    });
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

/** A described entry with every field explicit: no label, no options, nothing bound, no press, no state. */
export const entryOf = (type: string, over: Partial<DescribedElement> = {}): DescribedElement => ({
  type,
  label: null,
  options: [],
  bound: false,
  pressAction: null,
  showsState: false,
  ...over,
});
