import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildCatalogPrompt, videoMergeCatalog } from '@minitui/catalog';
import { composeSystemPrompt } from '../../src/generation.js';
import {
  CASE_DIR,
  loadCaseSet,
  parseCaseSet,
  renderPatchText,
  type GenerationCase,
} from '../../eval/harness/cases.js';

const HEADER = { status: 'draft', caseSetVersion: 1 };
const PROMPT = 'You are a UI generator. Use Box for layout, Text for text content.';

const line = (value: unknown): string => JSON.stringify(value);
const patch = (...lines: readonly unknown[]): string => `${lines.map(line).join('\n')}\n`;

// A merge app as patch lines, with the case's paths behind the placeholder.
const MERGE_REFERENCE = patch(
  { op: 'add', path: '/root', value: 'go' },
  {
    op: 'add',
    path: '/elements/go',
    value: {
      type: 'Button',
      props: { label: 'Merge' },
      on: {
        press: {
          action: 'merge',
          params: {
            inputs: { $state: '/inputs' },
            codec: { $state: '/codec' },
            output: { $state: '/output' },
          },
        },
      },
    },
  },
  {
    op: 'add',
    path: '/state',
    value: {
      inputs: [`${CASE_DIR}/a.mp4`, `${CASE_DIR}/b.mp4`],
      codec: 'copy',
      output: `${CASE_DIR}/out.mp4`,
      merge: { progress: 0, status: '' },
    },
  },
);

const BASE: GenerationCase = {
  id: 'merge-two',
  version: 1,
  suite: 'regression',
  split: 'dev',
  catalog: 'video-merge',
  input: { kind: 'intent', text: 'merge a.mp4 and b.mp4 into out.mp4' },
  files: ['a.mp4', 'b.mp4'],
  tags: ['merge'],
  requires: { components: ['Button'], actions: ['merge'] },
  needsModelWrittenCode: false,
  expect: {
    merge: {
      inputs: ['a.mp4', 'b.mp4'],
      ordered: true,
      output: 'out.mp4',
      codecs: ['copy'],
      editableInputs: false,
    },
    described: [],
    forbidActions: [],
  },
  reference: 'merge-two.jsonl',
  dryRun: null,
};

const setText = (cases: readonly unknown[], header: unknown = HEADER): string =>
  [header, ...cases].map(line).join('\n');

function parse(cases: readonly unknown[], files: Record<string, string> = {}) {
  return parseCaseSet(setText(cases), {
    systemPrompt: PROMPT,
    readReference: (file) => {
      const text = files[file] ?? (file === 'merge-two.jsonl' ? MERGE_REFERENCE : undefined);
      if (text === undefined) throw new Error(`no reference ${file}`);
      return text;
    },
  });
}

const withReference = (text: string) => parse([BASE], { 'merge-two.jsonl': text });

describe('the case loader', () => {
  it('reads the header, then the cases in order', () => {
    const second = { ...BASE, id: 'merge-two-again' };
    const set = parse([BASE, second]);
    expect(set.status).toBe('draft');
    expect(set.caseSetVersion).toBe(1);
    expect(set.cases.map((c) => c.id)).toEqual(['merge-two', 'merge-two-again']);
    expect(set.cases[0]).toEqual(BASE);
  });

  const refused: ReadonlyArray<readonly [string, () => unknown, RegExp]> = [
    ['a duplicate id', () => parse([BASE, BASE]), /duplicate id/],
    ['an id with an upper-case letter', () => parse([{ ...BASE, id: 'Merge-two' }]), /id/],
    ['an id with a space', () => parse([{ ...BASE, id: 'merge two' }]), /id/],
    ['a case naming another catalog', () => parse([{ ...BASE, catalog: 'notes' }]), /catalog/],
    [
      'a file name with a path separator',
      () => parse([{ ...BASE, files: ['clips/a.mp4', 'b.mp4'] }]),
      /file name/,
    ],
    ['a file name with a backslash', () => parse([{ ...BASE, files: ['a\\b.mp4'] }]), /file name/],
    ['a file name with ..', () => parse([{ ...BASE, files: ['..', 'b.mp4'] }]), /file name/],
    [
      'a file name with a control character',
      () => parse([{ ...BASE, files: [`a${String.fromCharCode(27)}.mp4`] }]),
      /file name/,
    ],
    [
      'a merge input that is not one of the files',
      () =>
        parse([
          {
            ...BASE,
            expect: { ...BASE.expect, merge: { ...BASE.expect.merge, inputs: ['a.mp4', 'c.mp4'] } },
          },
        ]),
      /merge input/,
    ],
    [
      'a case whose text appears in the system prompt',
      () => parse([{ ...BASE, input: { kind: 'intent', text: 'Use Box for layout' } }]),
      /system prompt/,
    ],
    [
      'a described entry naming nothing',
      () =>
        parse([
          {
            ...BASE,
            expect: {
              ...BASE.expect,
              described: [{ type: '', label: null, options: [], bound: false, pressAction: null }],
            },
          },
        ]),
      /described/,
    ],
    [
      'a described entry naming a component the catalog does not have',
      () =>
        parse([
          {
            ...BASE,
            expect: {
              ...BASE.expect,
              described: [
                { type: 'Slider', label: null, options: [], bound: false, pressAction: null },
              ],
            },
          },
        ]),
      /described/,
    ],
    [
      'a requires entry naming nothing',
      () => parse([{ ...BASE, requires: { components: [''], actions: [] } }]),
      /requires/,
    ],
    [
      'a case with neither a reference nor a dry-run reply',
      () => parse([{ ...BASE, reference: null, dryRun: null }]),
      /reference/,
    ],
    [
      'an absolute path in the input text',
      () => parse([{ ...BASE, input: { kind: 'intent', text: 'merge /srv/a.mp4 and b.mp4' } }]),
      /absolute path/,
    ],
    [
      'a quoted absolute path in the input text',
      () => parse([{ ...BASE, input: { kind: 'intent', text: "merge '/srv/a.mp4' and b.mp4" } }]),
      /absolute path/,
    ],
    [
      'a reference with a hard-coded absolute path',
      () => withReference(MERGE_REFERENCE.replace(`${CASE_DIR}/a.mp4`, '/home/someone/a.mp4')),
      /absolute path/,
    ],
    [
      'a dry-run reply with a hard-coded absolute path',
      () =>
        parse(
          [{ ...BASE, reference: null, dryRun: { reply: 'r.jsonl', stop: 'valid', cause: null } }],
          {
            'r.jsonl': MERGE_REFERENCE.replace(`${CASE_DIR}/out.mp4`, '/tmp/out.mp4'),
          },
        ),
      /absolute path/,
    ],
    [
      'a statePath outside an action binding or a repeat',
      () =>
        withReference(
          MERGE_REFERENCE.replace('"codec":"copy"', '"codec":"copy","statePath":"/elsewhere"'),
        ),
      /absolute path/,
    ],
    ['a reference line that is not JSON', () => withReference('{"op":"add",\n'), /JSON/],
    [
      'a reference file name with a separator',
      () => parse([{ ...BASE, reference: '../x.jsonl' }]),
      /file name/,
    ],
    ['a field the schema does not know', () => parse([{ ...BASE, weight: 2 }]), /case 1/],
    [
      'a header that is not a header',
      () =>
        parseCaseSet(setText([BASE], { draft: true }), {
          systemPrompt: PROMPT,
          readReference: () => MERGE_REFERENCE,
        }),
      /header/,
    ],
  ];

  it.each(refused)('refuses %s', (_name, load, message) => {
    expect(load).toThrow(message);
  });

  it('takes no JSON pointer for an absolute path', () => {
    const pointers = patch(
      { op: 'add', path: '/root', value: 'list' },
      {
        op: 'add',
        path: '/elements/list',
        value: {
          type: 'Box',
          props: {},
          repeat: { statePath: '/rows' },
          visible: { $state: '/shown' },
          children: ['row', 'clear'],
        },
      },
      {
        op: 'add',
        path: '/elements/row',
        value: { type: 'Text', props: { text: { $bindState: '/rows/0' } } },
      },
      {
        op: 'add',
        path: '/elements/clear',
        value: {
          type: 'Button',
          props: { label: 'Clear' },
          on: {
            press: {
              action: 'pushState',
              params: { statePath: '/rows', value: 'x', clearStatePath: '/draft' },
            },
          },
        },
      },
      { op: 'move', from: '/state/old', path: '/state/rows' },
      { op: 'add', path: '/elements/row/props/text/$state', value: '/rows/1' },
      { op: 'add', path: '/elements/list/repeat/statePath', value: '/rows' },
    );
    expect(withReference(pointers).cases).toHaveLength(1);
  });
});

describe('renderPatchText', () => {
  it('replaces the placeholder inside string leaves only', () => {
    const text = patch({
      op: 'add',
      path: '/state',
      value: { [CASE_DIR]: `${CASE_DIR}/a.mp4`, n: 3, list: [CASE_DIR] },
    });
    const [rendered] = renderPatchText(text, '/run/c01')
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rendered).toEqual({
      op: 'add',
      path: '/state',
      value: { [CASE_DIR]: '/run/c01/a.mp4', n: 3, list: ['/run/c01'] },
    });
  });

  it('keeps every line whole when the directory holds a quote, a backslash or a newline', () => {
    const dir = '/run/odd "dir" \\ name\nnext';
    const rendered = renderPatchText(MERGE_REFERENCE, dir);
    const lines = rendered
      .trimEnd()
      .split('\n')
      .map((l): unknown => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(rendered.endsWith('\n')).toBe(true);
    expect(JSON.stringify(lines[2])).toContain(JSON.stringify(`${dir}/a.mp4`));
  });

  it('leaves a JSON pointer and a non-string leaf as they were', () => {
    const rendered = renderPatchText(MERGE_REFERENCE, '/run/c02');
    expect(rendered).toContain('{"$state":"/inputs"}');
    expect(rendered).toContain('"progress":0');
    expect(rendered).not.toContain(CASE_DIR);
  });
});

// The draft set itself: it loads, its make-up holds, and no text measures copying from the prompt.
const CASE_FILE = fileURLToPath(new URL('../../eval/cases/generation.v1.jsonl', import.meta.url));
const realPrompt = composeSystemPrompt(buildCatalogPrompt(videoMergeCatalog), '/run/c01');

describe('the draft case set', () => {
  it('loads with the real system prompt, marked draft in its first line', () => {
    const set = loadCaseSet(CASE_FILE, { systemPrompt: realPrompt });
    expect(set.status).toBe('draft');
    expect(JSON.parse(readFileSync(CASE_FILE, 'utf8').split('\n')[0] ?? '')).toEqual({
      status: 'draft',
      caseSetVersion: 1,
    });
    expect(set.cases.length).toBeGreaterThanOrEqual(40);
  });

  it('no case text appears in the system prompt', () => {
    const { cases } = loadCaseSet(CASE_FILE, { systemPrompt: realPrompt });
    for (const c of cases) expect(realPrompt).not.toContain(c.input.text);
  });

  it('refuses a planted case whose text is a slice of the real system prompt', () => {
    const at = realPrompt.indexOf('Terminal UIs have limited width');
    const slice = realPrompt.slice(at, at + 60);
    expect(at).toBeGreaterThan(0);
    const planted = { ...BASE, input: { kind: 'intent', text: slice } };
    expect(() =>
      parseCaseSet(setText([planted]), {
        systemPrompt: realPrompt,
        readReference: () => MERGE_REFERENCE,
      }),
    ).toThrow(/system prompt/);
  });

  it('holds 30 regression and 12 capability cases, about a third of them in the test split', () => {
    const { cases } = loadCaseSet(CASE_FILE, { systemPrompt: realPrompt });
    const count = (pick: (c: GenerationCase) => boolean) => cases.filter(pick).length;
    expect(count((c) => c.suite === 'regression')).toBe(30);
    expect(count((c) => c.suite === 'capability')).toBe(12);
    expect(count((c) => c.split === 'test')).toBe(14);
    expect(count((c) => c.tags.includes('hostile'))).toBe(6);
    expect(count((c) => c.needsModelWrittenCode)).toBe(2);
    expect(cases[0]?.tags).toContain('hand-run');
  });

  it('holds no raw control character: escapes are written as JSON escapes', () => {
    const raw = readFileSync(CASE_FILE, 'utf8');
    expect(raw.replaceAll('\n', '')).not.toMatch(/\p{Cc}/u);
    expect(raw).toContain('\\u001b');
  });
});
