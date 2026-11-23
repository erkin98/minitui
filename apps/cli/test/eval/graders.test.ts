import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { buildCatalogPrompt, videoMergeCatalog } from '@minitui/catalog';
import type { MiniAppSpec } from '@minitui/spec';
import { composeSystemPrompt } from '../../src/generation.js';
import {
  CASE_DIR,
  loadCaseSet,
  renderPatchText,
  type DescribedElement,
  type GenerationCase,
  type MergeExpectation,
} from '../../eval/harness/cases.js';
import type { StopKind } from '../../eval/harness/trial.js';
import { CATALOG_CHECKERS, capabilityCause } from '../../eval/graders/index.js';
import {
  DIR,
  app,
  editPatch,
  entryOf,
  failingNames,
  replay,
  result,
  run,
  validated,
  type Json,
} from '../support/eval-grading.js';

const ESC = String.fromCharCode(27);

// A conditional prop value: json-render shows the branch the condition on `path` picks.
const cond = (path: string, then: Json, otherwise: Json): Json => ({
  $cond: { $state: path },
  $then: then,
  $else: otherwise,
});

const merge = (params: Json = MERGE_PARAMS, event = 'press'): Json => ({
  [event]: { action: 'merge', params },
});
const MERGE_PARAMS = {
  inputs: { $state: '/inputs' },
  codec: { $state: '/codec' },
  output: { $state: '/output' },
};
const SEEDED = { merge: { progress: 0, status: '' } };

const MERGE_CASE: GenerationCase = {
  id: 'health-merge',
  version: 1,
  suite: 'regression',
  split: 'dev',
  catalog: 'video-merge',
  input: { kind: 'intent', text: 'merge a, b and c in that order into out.mp4' },
  files: ['a.mp4', 'b.mp4', 'c.mp4'],
  tags: ['merge'],
  requires: { components: ['Button'], actions: ['merge'] },
  needsModelWrittenCode: false,
  expect: {
    merge: {
      inputs: ['a.mp4', 'b.mp4', 'c.mp4'],
      ordered: true,
      output: 'out.mp4',
      codecs: ['copy', 'h264'],
      editableInputs: true,
    },
    described: [],
    forbidActions: ['setState'],
  },
  reference: 'health-merge.jsonl',
  dryRun: null,
};

const INPUTS = [`${CASE_DIR}/a.mp4`, `${CASE_DIR}/b.mp4`, `${CASE_DIR}/c.mp4`];
const MERGE_STATE = { inputs: INPUTS, codec: 'copy', output: `${CASE_DIR}/out.mp4`, ...SEEDED };
const mergeElements = (over: Record<string, Json> = {}): Record<string, Json> => ({
  main: { type: 'Box', props: { flexDirection: 'column' }, children: ['order', 'go'] },
  order: { type: 'OrderList', props: { items: { $bindState: '/inputs' } } },
  go: { type: 'Button', props: { label: 'Merge' }, on: merge() },
  ...over,
});

// The reference, and a differently encoded app that is just as right: one file picker per input, the
// press binding as a list, another acceptable codec, paths spelled with `.` and a doubled separator.
const MERGE_GOOD = app(mergeElements(), MERGE_STATE);
const MERGE_GOOD_OTHER = app(
  {
    shell: { type: 'Box', props: {}, children: ['inner'] },
    inner: { type: 'Box', props: { flexDirection: 'column' }, children: ['p0', 'p1', 'p2', 'run'] },
    p0: { type: 'FilePicker', props: { value: { $bindState: '/inputs/0' }, mode: 'file' } },
    p1: { type: 'FilePicker', props: { value: { $bindState: '/inputs/1' } } },
    p2: { type: 'FilePicker', props: { value: { $bindState: '/inputs/2' } } },
    run: {
      type: 'Button',
      props: { label: 'Go' },
      on: { press: [{ action: 'merge', params: MERGE_PARAMS }] },
    },
  },
  {
    ...MERGE_STATE,
    inputs: [`${CASE_DIR}/./a.mp4`, `${CASE_DIR}//b.mp4`, `${CASE_DIR}/c.mp4`],
    codec: 'h264',
    output: `${CASE_DIR}/./out.mp4`,
    note: 'ready',
  },
  'shell',
);

// One deliberately wrong app per check, each still a valid spec.
const MERGE_BAD: ReadonlyArray<readonly [string, string]> = [
  [
    'merge-on-press',
    app(
      mergeElements({
        go: { type: 'Text', props: { text: 'Pick an order' } },
        order: {
          type: 'OrderList',
          props: { items: { $bindState: '/inputs' } },
          on: merge(MERGE_PARAMS, 'reorder'),
        },
      }),
      MERGE_STATE,
    ),
  ],
  ['inputs-match', app(mergeElements(), { ...MERGE_STATE, inputs: [...INPUTS].reverse() })],
  ['output-match', app(mergeElements(), { ...MERGE_STATE, output: `${CASE_DIR}/other.mp4` })],
  ['codec-acceptable', app(mergeElements(), { ...MERGE_STATE, codec: 'mpeg4' })],
  [
    'inputs-editable',
    app(
      mergeElements({ order: { type: 'OrderList', props: { items: { $state: '/inputs' } } } }),
      MERGE_STATE,
    ),
  ],
  [
    'no-forbidden-action',
    app(
      mergeElements({
        main: { type: 'Box', props: {}, children: ['order', 'go', 'reset'] },
        reset: {
          type: 'Button',
          props: { label: 'Reset' },
          on: { press: { action: 'setState', params: { statePath: '/codec', value: 'copy' } } },
        },
      }),
      MERGE_STATE,
    ),
  ],
  [
    'escape-free-leaves',
    app(
      mergeElements({ go: { type: 'Button', props: { label: `Merge${ESC}[2J` }, on: merge() } }),
      MERGE_STATE,
    ),
  ],
];

describe('grader health: the merge checks and the shared ones', () => {
  it('the reference and a differently encoded app pass every check', async () => {
    for (const text of [MERGE_GOOD, MERGE_GOOD_OTHER]) {
      const checks = run(MERGE_CASE, await validated(text));
      expect(checks.filter((c) => !c.pass)).toEqual([]);
      expect(checks.map((c) => c.name)).toEqual([
        'valid',
        'first-attempt-valid',
        'no-forbidden-action',
        'escape-free-leaves',
        'merge-on-press',
        'inputs-match',
        'output-match',
        'codec-acceptable',
        'inputs-editable',
      ]);
    }
  });

  it.each(MERGE_BAD)('%s fails its known-bad app, and only that check does', async (name, text) => {
    const checks = run(MERGE_CASE, await validated(text));
    expect(checks.filter((c) => !c.pass).map((c) => c.name)).toEqual([name]);
  });

  it('inputs-match and output-match refuse a missing input, a step out of the directory and a URL', async () => {
    const spec = await validated(MERGE_GOOD);
    const withState = (state: Record<string, unknown>): MiniAppSpec => ({
      ...spec,
      state: { ...spec.state, ...state },
    });
    const failing = (s: MiniAppSpec) =>
      run(MERGE_CASE, s)
        .filter((c) => !c.pass)
        .map((c) => c.name);
    expect(failing(withState({ inputs: [`${DIR}/a.mp4`, `${DIR}/b.mp4`] }))).toEqual([
      'inputs-match',
    ]);
    expect(
      failing(withState({ inputs: [`${DIR}/a.mp4`, `${DIR}/b.mp4`, `${DIR}/x/../c.mp4`] })),
    ).toEqual(['inputs-match']);
    expect(failing(withState({ inputs: ['a.mp4', 'b.mp4', 'c.mp4'] }))).toEqual(['inputs-match']);
    expect(failing(withState({ output: 'https://example.com/out.mp4' }))).toEqual(['output-match']);
    expect(failing(withState({ output: `${DIR}/sub/out.mp4` }))).toEqual(['output-match']);
    expect(failing(withState({ output: `/run/c02/out.mp4` }))).toEqual(['output-match']);
  });

  // The app refuses a merge whose output is one of its own inputs (packages/exec/src/exec/ffmpeg.ts), so
  // output-match does too: against the spec's own resolved inputs of the same merge, never the case's
  // expected ones, and by file name, so a `./` or `//` spelling of one file is the same file.
  const mergeCase = (over: Partial<MergeExpectation>): GenerationCase => ({
    ...MERGE_CASE,
    expect: { ...MERGE_CASE.expect, merge: { ...MERGE_CASE.expect.merge!, ...over } },
  });
  // a path in the case directory: at('a') is a.mp4, at('./a') spells it with a . segment, at('/b') with //
  const at = (name: string): string => `${CASE_DIR}/${name}.mp4`;
  const OPEN = mergeCase({ output: null });
  const NAMES_A = mergeCase({ output: 'a.mp4' });
  // the spec lists a, b and z; the case asks for a, b and c
  const LISTED_Z = { inputs: [at('a'), at('b'), at('z')], output: at('z') };
  const LISTED_C = { ...LISTED_Z, output: at('c') };
  const OVER_AN_INPUT: ReadonlyArray<
    readonly [string, GenerationCase, Record<string, Json>, readonly string[]]
  > = [
    ['a named output that is itself an input', NAMES_A, { output: at('a') }, ['output-match']],
    ['the same file spelled with a . segment', NAMES_A, { output: at('./a') }, ['output-match']],
    ['an open output spelled with //', OPEN, { output: at('/b') }, ['output-match']],
    ['an open output that is the last input', OPEN, { output: at('c') }, ['output-match']],
    ['a named output the case does not ask for', MERGE_CASE, { output: at('a') }, ['output-match']],
    ['an output the spec lists, not asked for', OPEN, LISTED_Z, ['inputs-match', 'output-match']],
    ['an output asked for, not listed by the spec', OPEN, LISTED_C, ['inputs-match']],
  ];

  it.each(OVER_AN_INPUT)('output-match: %s', async (_name, testCase, state, expected) => {
    const checks = run(
      testCase,
      await validated(app(mergeElements(), { ...MERGE_STATE, ...state })),
    );
    expect(failingNames(checks)).toEqual(expected);
    // the evidence is fixed text naming both reasons, never a path
    if (expected.includes('output-match'))
      expect(result(checks, 'output-match').evidence).toBe(
        'the merge output is not the asked file in the case directory, or is one of its inputs',
      );
  });

  it('valid and first-attempt-valid read the stop and the attempts', async () => {
    const spec = await validated(MERGE_GOOD);
    expect(result(run(MERGE_CASE, spec, { attempts: 2 }), 'first-attempt-valid')).toMatchObject({
      pass: false,
      diagnostic: true,
    });
    expect(result(run(MERGE_CASE, spec, { attempts: 2 }), 'valid').pass).toBe(true);
    const exhausted = run(MERGE_CASE, null, { stop: 'exhausted', attempts: 6 });
    expect(result(exhausted, 'valid').pass).toBe(false);
    expect(result(exhausted, 'first-attempt-valid').pass).toBe(false);
  });

  it('an unordered case takes the files in any order, and an open output any file in the directory', async () => {
    const open: GenerationCase = {
      ...MERGE_CASE,
      expect: {
        ...MERGE_CASE.expect,
        merge: { ...MERGE_CASE.expect.merge!, ordered: false, output: null },
      },
    };
    const spec = await validated(MERGE_BAD[1]![1]);
    const renamed = { ...spec, state: { ...spec.state, output: `${DIR}/joined.mp4` } };
    expect(run(open, renamed).filter((c) => !c.pass)).toEqual([]);
  });

  it('resolves a literal and a two-way pointer the same way as a one-way pointer (not a validated spec)', async () => {
    // The catalog's gate requires the merge params as one-way pointers, so these never validate; the
    // checker still reads every form the spec grammar allows.
    const spec = await validated(MERGE_GOOD);
    const go = spec.elements.go;
    if (go === undefined) throw new Error('no go');
    const literal: MiniAppSpec = {
      ...spec,
      elements: {
        ...spec.elements,
        go: {
          ...go,
          on: {
            press: {
              action: 'merge',
              params: {
                inputs: [`${DIR}/a.mp4`, `${DIR}/b.mp4`, `${DIR}/c.mp4`],
                codec: 'copy',
                output: { $bindState: '/output' },
              },
            },
          },
        },
      },
    };
    expect(
      run(MERGE_CASE, literal)
        .filter((c) => !c.pass)
        .map((c) => c.name),
    ).toEqual(['inputs-editable']);
  });

  it('a case with no codec cue takes any codec the valid spec names; a named codec does not', async () => {
    const spec = await validated(app(mergeElements(), { ...MERGE_STATE, codec: 'libaom-av1' }));
    const withCodecs = (codecs: readonly string[]): GenerationCase => ({
      ...MERGE_CASE,
      expect: { ...MERGE_CASE.expect, merge: { ...MERGE_CASE.expect.merge!, codecs } },
    });
    expect(result(run(withCodecs([]), spec), 'codec-acceptable').pass).toBe(true);
    expect(result(run(withCodecs(['h264', 'libx264']), spec), 'codec-acceptable').pass).toBe(false);
  });

  it('inputs that resolve to no file are not editable (not a validated spec)', async () => {
    // The catalog asks for at least two inputs, so this never validates; the checker must still not
    // pass an empty list for want of an item to check.
    const spec = await validated(MERGE_GOOD);
    const empty = { ...spec, state: { ...spec.state, inputs: [] } };
    const order = spec.elements.order;
    if (order === undefined) throw new Error('no order');
    const noEditor = {
      ...empty,
      elements: { ...spec.elements, order: { ...order, type: 'Text' } },
    };
    expect(result(run(MERGE_CASE, noEditor), 'inputs-editable').pass).toBe(false);
    expect(result(run(MERGE_CASE, empty), 'inputs-editable').pass).toBe(false);
  });
});

const DESCRIBED_CASE: GenerationCase = {
  ...MERGE_CASE,
  id: 'health-described',
  input: { kind: 'description', text: 'a speed menu and a go button' },
  files: [],
  requires: { components: ['Select', 'Button'], actions: ['setState'] },
  expect: {
    merge: null,
    described: [
      entryOf('Select', { label: 'speed', options: ['slow', 'fast'], bound: true }),
      entryOf('Button', { label: 'go', pressAction: 'setState' }),
    ],
    forbidActions: [],
  },
};
const OPTIONS = [
  { label: 'Slow', value: 'slow' },
  { label: 'Normal', value: 'normal' },
  { label: 'Fast', value: 'fast' },
];
const describedElements = (over: Record<string, Json> = {}): Record<string, Json> => ({
  main: { type: 'Box', props: { flexDirection: 'column' }, children: ['speed', 'go'] },
  speed: {
    type: 'Select',
    props: { label: 'Speed', options: OPTIONS, value: { $bindState: '/speed' } },
  },
  go: {
    type: 'Button',
    props: { label: 'Go' },
    on: { press: { action: 'setState', params: { statePath: '/speed', value: 'fast' } } },
  },
  ...over,
});
const DESCRIBED_GOOD = app(describedElements(), { speed: 'slow' });
// The label and the options read from state, the press as a list, the elements in another order.
const DESCRIBED_GOOD_OTHER = app(
  {
    main: { type: 'Box', props: {}, children: ['start', 'menu'] },
    start: {
      type: 'Button',
      props: { label: 'GO NOW' },
      on: { press: [{ action: 'setState', params: { statePath: '/chosen', value: 'fast' } }] },
    },
    menu: {
      type: 'Select',
      props: {
        label: { $state: '/title' },
        options: { $state: '/speeds' },
        value: { $state: '/chosen' },
      },
    },
  },
  { title: 'Playback SPEED', speeds: OPTIONS, chosen: 'normal' },
);
const DESCRIBED_BAD: ReadonlyArray<readonly [string, string]> = [
  [
    'described-1-select',
    app(
      describedElements({
        speed: {
          type: 'Select',
          props: { label: 'Speed', options: OPTIONS.slice(0, 2), value: { $bindState: '/speed' } },
        },
      }),
      { speed: 'slow' },
    ),
  ],
  [
    'described-1-select',
    app(
      describedElements({ speed: { type: 'Select', props: { label: 'Speed', options: OPTIONS } } }),
      { speed: 'slow' },
    ),
  ],
  [
    'described-1-select',
    app(
      describedElements({
        speed: {
          type: 'Select',
          props: { label: 'Tempo', options: OPTIONS, value: { $bindState: '/speed' } },
        },
      }),
      { speed: 'slow' },
    ),
  ],
  [
    'described-2-button',
    app(
      describedElements({
        go: {
          type: 'Button',
          props: { label: 'Go' },
          on: { press: { action: 'pushState', params: { statePath: '/log', value: 'go' } } },
        },
      }),
      { speed: 'slow', log: [] },
    ),
  ],
];

describe('grader health: the described elements', () => {
  it('the reference and a differently encoded app pass every check', async () => {
    for (const text of [DESCRIBED_GOOD, DESCRIBED_GOOD_OTHER]) {
      const checks = run(DESCRIBED_CASE, await validated(text));
      expect(checks.filter((c) => !c.pass)).toEqual([]);
      expect(checks.map((c) => c.name).slice(4)).toEqual([
        'described-1-select',
        'described-2-button',
      ]);
    }
  });

  it.each(DESCRIBED_BAD)('%s fails a known-bad app', async (name, text) => {
    const checks = run(DESCRIBED_CASE, await validated(text));
    expect(checks.filter((c) => !c.pass).map((c) => c.name)).toEqual([name]);
  });

  it('matches the most constrained entry first, so a looser one takes what is left', async () => {
    const looseFirst: GenerationCase = {
      ...DESCRIBED_CASE,
      expect: {
        ...DESCRIBED_CASE.expect,
        described: [entryOf('Button'), entryOf('Button', { label: 'go', pressAction: 'setState' })],
      },
    };
    const twoButtons = app(
      describedElements({
        main: { type: 'Box', props: {}, children: ['go', 'other'] },
        other: {
          type: 'Button',
          props: { label: 'Other' },
          on: { press: { action: 'setState', params: { statePath: '/speed', value: 'slow' } } },
        },
      }),
      { speed: 'slow' },
    );
    expect(run(looseFirst, await validated(twoButtons)).filter((c) => !c.pass)).toEqual([]);
    const oneButton = await validated(DESCRIBED_GOOD);
    expect(
      run(looseFirst, oneButton)
        .filter((c) => !c.pass)
        .map((c) => c.name),
    ).toEqual(['described-1-button']);
  });

  // showsState: the element's displayed text (its label prop, else its text prop) reads state when it
  // renders: a state or item marker, a template with a ${...} hole, or a $cond whose chosen branch does;
  // never a fixed string.
  const asksText = entryOf('Text', { showsState: true });
  const describing = (...described: DescribedElement[]): GenerationCase => ({
    ...DESCRIBED_CASE,
    expect: { merge: null, described, forbidActions: [] },
  });
  // an app of one Text for each text given, in that order
  const textApp = (...texts: Json[]): string =>
    app(
      {
        main: { type: 'Box', props: {}, children: texts.map((_, i) => `t${i}`) },
        ...Object.fromEntries(texts.map((text, i) => [`t${i}`, { type: 'Text', props: { text } }])),
      },
      { count: 3 },
    );

  // a Text in a repeat over /items, where an $item or $bindItem marker belongs
  const repeatApp = (text: Json): string =>
    app(
      {
        main: { type: 'Box', props: {}, children: ['list'] },
        list: { type: 'Box', props: {}, repeat: { statePath: '/items' }, children: ['t0'] },
        t0: { type: 'Text', props: { text } },
      },
      { items: [{ name: 'a' }, { name: 'b' }] },
    );
  const read = { $state: '/count' };

  it.each([
    ['a state marker', { $state: '/count' }, []],
    // pointerOf, and so the label reading above it, takes the two-way marker as a state read too
    ['a two-way state marker', { $bindState: '/count' }, []],
    ['a template naming a pointer', { $template: 'Count: ${/count}' }, []],
    ['a fixed string', 'Count', ['described-1-text']],
    ['a template naming no pointer', { $template: 'Count' }, ['described-1-text']],
    // json-render reads a bare ${name} from state like ${/name}; a ${} with no name is no hole, plain text
    ['a template naming a bare field', { $template: 'Count: ${count}' }, []],
    ['a template with an empty hole', { $template: 'Count: ${}' }, ['described-1-text']],
    // a $cond shows the branch it picks: a branch that reads state shows state, two fixed strings do not,
    // whatever the condition reads
    [
      'a $cond with a template branch',
      cond('/count', { $template: 'Count: ${/count}' }, 'none yet'),
      [],
    ],
    ['a $cond with a state marker in $else', cond('/count', 'some', read), []],
    ['a $cond nested in a branch', cond('/count', cond('/count', 'three', read), 'none'), []],
    ['a $cond with two fixed branches', cond('/count', 'some', 'none'), ['described-1-text']],
    // json-render reads a $cond only when it also has $then and $else; an incomplete one is a plain object
    ['an incomplete $cond', { $cond: read, $then: read }, ['described-1-text']],
  ])('showsState on a Text: %s', async (_name, text, expected) => {
    const spec = await validated(textApp(text));
    expect(failingNames(run(describing(asksText), spec))).toEqual(expected);
  });

  it.each([
    ['an $item marker', { $item: 'name' }, []],
    ['a $bindItem marker', { $bindItem: 'name' }, []],
    ['an $index marker, a number and not state', { $index: true }, ['described-1-text']],
  ])('showsState on a Text in a repeat: %s', async (_name, text, expected) => {
    const spec = await validated(repeatApp(text));
    expect(failingNames(run(describing(asksText), spec))).toEqual(expected);
  });

  it('showsState reads the label prop when the element has one', async () => {
    const asking = describing(
      entryOf('Select', {
        label: 'speed',
        options: ['slow', 'fast'],
        bound: true,
        showsState: true,
      }),
    );
    // the label comes from state in one app and is the fixed string "Speed" in the other
    const failing = async (text: string) => failingNames(run(asking, await validated(text)));
    expect(await failing(DESCRIBED_GOOD_OTHER)).toEqual([]);
    expect(await failing(DESCRIBED_GOOD)).toEqual(['described-1-select']);
  });

  it('showsState counts in the weight: an entry that asks for state is matched before a looser one', async () => {
    // the Text that shows state comes first among the elements, and the loose entry is listed first: only
    // matching the heavier entry first leaves the fixed Text to the loose one
    const spec = await validated(textApp({ $state: '/count' }, 'Hello'));
    const testCase = describing(entryOf('Text'), asksText);
    expect(failingNames(run(testCase, spec))).toEqual([]);
  });
});

describe('a trial with no validated spec', () => {
  it('carries the same check names, each spec check failed with fixed evidence', async () => {
    for (const testCase of [MERGE_CASE, DESCRIBED_CASE]) {
      const good = run(
        testCase,
        await validated(testCase === MERGE_CASE ? MERGE_GOOD : DESCRIBED_GOOD),
      );
      const none = run(testCase, null, { stop: 'provider-error', attempts: 1 });
      expect(none.map((c) => c.name)).toEqual(good.map((c) => c.name));
      expect(none.every((c) => !c.pass)).toBe(true);
      expect(none.slice(2).every((c) => c.evidence === 'no validated spec')).toBe(true);
      expect(none.map((c) => c.diagnostic)).toEqual(good.map((c) => c.diagnostic));
    }
  });
});

// The case set, through the real loop: the references, the dry-run replies and the causes.
const CASE_FILE = fileURLToPath(new URL('../../eval/cases/generation.v1.jsonl', import.meta.url));
const SET = loadCaseSet(CASE_FILE, {
  systemPrompt: composeSystemPrompt(buildCatalogPrompt(videoMergeCatalog), '/run/c01'),
});
const patchOf = (file: string): string => {
  const text = SET.patches.get(file);
  if (text === undefined) throw new Error(`the set holds no ${file}`);
  return text;
};
const dirOf = (position: number): string => `/run/c${String(position).padStart(2, '0')}`;
const positioned = SET.cases.map((testCase, index) => ({ testCase, dir: dirOf(index + 1) }));
const withReference = positioned.filter(({ testCase }) => testCase.reference !== null);

// One wrong spec per check, made from a case's own validated reference: the check it names must fail.
function breakFor(name: string, spec: MiniAppSpec, testCase: GenerationCase): MiniAppSpec {
  const state = { ...spec.state };
  const elements = { ...spec.elements };
  const retype = (from: string, to: string) => {
    for (const [key, element] of Object.entries(elements)) {
      if (element.type === from) elements[key] = { ...element, type: to };
    }
  };
  if (name === 'inputs-match' && Array.isArray(state.inputs)) state.inputs = state.inputs.slice(1);
  if (name === 'output-match') state.output = `${String(state.output)}.elsewhere/x.mp4`;
  if (name === 'codec-acceptable') state.codec = 'not-a-codec';
  if (name === 'merge-on-press') retype('Button', 'Text');
  if (name === 'inputs-editable') {
    retype('OrderList', 'Text');
    retype('FilePicker', 'Text');
  }
  if (name === 'escape-free-leaves') state.note = `${ESC}[2J`;
  if (name === 'no-forbidden-action') {
    elements.forbidden = {
      type: 'Button',
      props: { label: 'x' },
      on: { press: { action: testCase.expect.forbidActions[0] ?? '' } },
    };
  }
  const described = /^described-(\d+)-/.exec(name);
  const entry =
    described === null ? undefined : testCase.expect.described[Number(described[1]) - 1];
  if (entry !== undefined) retype(entry.type, 'Box');
  return { ...spec, elements, state };
}

// A reference with the text of every Text element replaced by `text`.
function withText(patch: string, text: unknown): string {
  return editPatch(patch, (line) => {
    const { type, props } = line.value;
    if (!line.path.startsWith('/elements/') || type !== 'Text' || typeof props !== 'object') {
      return line;
    }
    return { ...line, value: { ...line.value, props: { ...props, text } } };
  });
}

// A reference whose state writes the merge output over its first input: what the app refuses to run.
function outputOverFirstInput(patch: string): string {
  return editPatch(patch, (line) => {
    if (line.path !== '/state') return line;
    const first: unknown = Array.isArray(line.value.inputs) ? line.value.inputs[0] : undefined;
    if (typeof first !== 'string') throw new Error('the reference state has no first input');
    return { ...line, value: { ...line.value, output: first } };
  });
}

describe('the case set through the real validation', () => {
  it.each(withReference.map((p) => [p.testCase.id, p] as const))(
    '%s: its reference validates and passes every check; each check fails a spec broken for it',
    async (_id, { testCase, dir }) => {
      const spec = await validated(patchOf(testCase.reference ?? ''), dir);
      const checks = run(testCase, spec, { dir });
      expect(checks.filter((c) => !c.pass)).toEqual([]);
      const names = checks.map((c) => c.name);
      expect(run(testCase, null, { dir }).map((c) => c.name)).toEqual(names);
      for (const name of names) {
        if (name === 'valid' || name === 'first-attempt-valid') continue;
        if (name === 'no-forbidden-action' && testCase.expect.forbidActions.length === 0) continue;
        // no codec cue: every codec the valid spec names is right, so no spec breaks this check
        if (name === 'codec-acceptable' && testCase.expect.merge?.codecs.length === 0) continue;
        const broken = run(testCase, breakFor(name, spec, testCase), { dir });
        expect([name, result(broken, name).pass]).toEqual([name, false]);
      }
    },
  );

  it.each(
    positioned.filter((p) => p.testCase.dryRun !== null).map((p) => [p.testCase.id, p] as const),
  )(
    '%s: its dry-run reply reaches the declared stop, and the declared cause is the one the code decides',
    async (_id, { testCase, dir }) => {
      const dry = testCase.dryRun!;
      const { spec, attempts } = await replay(renderPatchText(patchOf(dry.reply), dir));
      const stop: StopKind = spec === null ? 'exhausted' : 'valid';
      expect(stop).toBe(dry.stop);
      if (stop === 'exhausted') expect(attempts).toBe(6);
      const checks = run(testCase, spec, { dir, attempts });
      const passAll = stop === 'valid' && checks.every((c) => c.diagnostic || c.pass);
      expect(capabilityCause(testCase, videoMergeCatalog, passAll)).toBe(dry.cause);
    },
  );

  // Only a case that leaves the merge output open fails output-match because of the clash: one that names
  // its output fails through the wrong name with or without it (the synthetic rows above cover that).
  const openOutput = positioned.filter(
    ({ testCase }) => testCase.expect.merge?.output === null && testCase.reference !== null,
  );

  it('the merge rows below cover every case that leaves the merge output open', () => {
    expect(openOutput).toHaveLength(
      SET.cases.filter((c) => c.expect.merge?.output === null).length,
    );
    expect(openOutput.map(({ testCase }) => testCase.id)).toContain('merge-pick-order-two');
  });

  it.each(openOutput.map((p) => [p.testCase.id, p] as const))(
    '%s: its reference with the merge output set to its first input fails output-match and nothing else',
    async (_id, { testCase, dir }) => {
      const spec = await validated(outputOverFirstInput(patchOf(testCase.reference ?? '')), dir);
      expect(failingNames(run(testCase, spec, { dir }))).toEqual(['output-match']);
    },
  );

  const caseAt = (id: string) => {
    const found = positioned.find(({ testCase }) => testCase.id === id);
    if (found === undefined) throw new Error(`the set holds no ${id}`);
    return found;
  };

  // The two references whose Text must show state: a fixed string in its place fails that entry's check.
  it.each([
    ['describe-counter-reset', 'Count', 'described-1-text'],
    ['cap-pick-folder', 'Picked', 'described-2-text'],
  ])(
    '%s: its Text with the fixed string "%s" fails %s and nothing else',
    async (id, text, name) => {
      const { testCase, dir } = caseAt(id);
      const spec = await validated(withText(patchOf(testCase.reference ?? ''), text), dir);
      expect(failingNames(run(testCase, spec, { dir }))).toEqual([name]);
    },
  );

  // A $cond is read for the branch it picks: with a template branch cap-pick-folder still shows state,
  // with two fixed strings it does not.
  it.each([
    [
      'a template branch',
      cond('/folder', { $template: 'Picked: ${/folder}' }, 'Nothing picked yet'),
      [],
    ],
    ['two fixed branches', cond('/folder', 'Picked', 'Nothing picked yet'), ['described-2-text']],
  ])('cap-pick-folder: its Text as a $cond with %s', async (_name, text, expected) => {
    const { testCase, dir } = caseAt('cap-pick-folder');
    const spec = await validated(withText(patchOf(testCase.reference ?? ''), text), dir);
    expect(failingNames(run(testCase, spec, { dir }))).toEqual(expected);
  });

  it('every case names a catalog with a checker', () => {
    for (const { testCase } of positioned) expect(CATALOG_CHECKERS[testCase.catalog]).toBeDefined();
  });
});

describe('the capability cause', () => {
  const byCause = (cause: string) => {
    const found = SET.cases.find((c) => c.dryRun?.cause === cause);
    if (found === undefined) throw new Error(`no case with cause ${cause}`);
    return found;
  };
  const buildable = SET.cases.find((c) => c.suite === 'capability' && c.reference !== null);

  it('is decided from the case before the result: one case of each cause', () => {
    for (const cause of [
      'missing-component',
      'missing-action',
      'needs-model-written-code',
    ] as const) {
      const testCase = byCause(cause);
      expect(capabilityCause(testCase, videoMergeCatalog, true)).toBe(cause);
      expect(capabilityCause(testCase, videoMergeCatalog, false)).toBe(cause);
    }
    if (buildable === undefined) throw new Error('no buildable capability case');
    expect(capabilityCause(buildable, videoMergeCatalog, true)).toBe('pass');
    expect(capabilityCause(buildable, videoMergeCatalog, false)).toBe('model-error');
  });

  it('names a missing component before a missing action, and is null for a regression case', () => {
    const both: GenerationCase = {
      ...MERGE_CASE,
      suite: 'capability',
      requires: { components: ['Chart'], actions: ['plot'] },
      needsModelWrittenCode: true,
    };
    expect(capabilityCause(both, videoMergeCatalog, true)).toBe('missing-component');
    expect(
      capabilityCause(
        { ...both, requires: { components: ['Text'], actions: ['plot'] } },
        videoMergeCatalog,
        true,
      ),
    ).toBe('missing-action');
    expect(capabilityCause(MERGE_CASE, videoMergeCatalog, true)).toBeNull();
  });
});
