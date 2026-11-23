import { describe, expect, it } from 'vitest';
import type { DescribedElement, GenerationCase } from '../../eval/harness/cases.js';
import {
  app,
  entryOf,
  failingNames,
  result,
  run,
  validated,
  type Json,
} from '../support/eval-grading.js';

// The described-elements checker, on what a person reads: a label written as a template or a conditional,
// and a value that carries both a conditional and a template. Each spec goes through the real loop.

const describing = (...described: DescribedElement[]): GenerationCase => ({
  id: 'health-described',
  version: 1,
  suite: 'regression',
  split: 'dev',
  catalog: 'video-merge',
  input: { kind: 'description', text: 'a join button and a count' },
  files: [],
  tags: ['described'],
  requires: { components: ['Button', 'Text'], actions: ['setState'] },
  needsModelWrittenCode: false,
  expect: { merge: null, described, forbidActions: [] },
  reference: null,
  dryRun: null,
});

const STATE = { n: 3, x: 'Join', flag: true, clip: { count: 3 } };

// An app of one element under the root: a Button that presses setState with its label as given, or a Text.
const appOf = (type: 'Button' | 'Text', shown: Json): string =>
  app(
    {
      main: { type: 'Box', props: {}, children: ['it'] },
      it:
        type === 'Button'
          ? {
              type,
              props: { label: shown },
              on: { press: { action: 'setState', params: { statePath: '/n', value: 1 } } },
            }
          : { type, props: { text: shown } },
    },
    STATE,
  );

// A conditional value on /flag, with keys beside it when given.
const cond = (then: Json, otherwise: Json, beside: Record<string, Json> = {}): Json => ({
  $cond: { $state: '/flag' },
  $then: then,
  $else: otherwise,
  ...beside,
});

describe('a described label written as a template or a conditional', () => {
  const failing = async (label: Json, part: string): Promise<string[]> =>
    failingNames(
      run(describing(entryOf('Button', { label: part })), await validated(appOf('Button', label))),
    );

  // The text of a template is the template with each hole filled from the spec's state; a conditional
  // shows one of its branches, picked when it renders, so the label may be read from either.
  it.each([
    ['a template with an absolute hole', { $template: 'Join ${/n} clips' }, 'join'],
    [
      'a template with a bare hole, read from the state root',
      { $template: 'Join ${n} clips' },
      'join',
    ],
    ['a template whose text is only a hole', { $template: '${/x}' }, 'join'],
    ['a template: the filled text as a whole', { $template: 'Join ${/n} clips' }, 'join 3 clips'],
    [
      'a template: a bare hole, its value in the text',
      { $template: 'Join ${n} clips' },
      'join 3 clips',
    ],
    // a hole needs a name between the braces, so an empty one stays text
    ['a template: an empty hole, as plain text', { $template: 'Join ${} clips' }, 'join ${} clips'],
    [
      'a template: a hole into a nested path, in any case',
      { $template: 'Join ${/clip/count} clips' },
      'JOIN 3 CLIPS',
    ],
    ['a template: a missing value as an empty string', { $template: 'Go${/missing}!' }, 'go!'],
    ['a $cond, in its $else', cond('Wait', 'Join'), 'join'],
    ['a $cond, in its $then', cond('Join', 'Wait'), 'join'],
    ['a $cond with a template branch', cond({ $template: 'Join ${/n}' }, 'Wait'), 'join 3'],
    ['a $cond with a state marker in a branch', cond({ $state: '/x' }, 'Wait'), 'join'],
    ['a $cond nested in a branch', cond(cond('Stop', 'Join'), 'Wait'), 'join'],
    // json-render reads $state (276) and $bindState (286) before the item marker that sits beside them
    ['a $state marker beside an $item marker: the state', { $state: '/x', $item: 'name' }, 'join'],
    [
      'a $bindState marker beside a $bindItem marker: the state',
      { $bindState: '/x', $bindItem: 'name' },
      'join',
    ],
    // json-render tests a $cond before a $template, so the branches are what shows
    [
      'a $cond beside a $template: the branches',
      cond('Wait', 'Stop', { $template: 'Join ${/n}' }),
      'wait',
    ],
  ])('%s matches', async (_name, label, part) => {
    expect(await failing(label, part)).toEqual([]);
  });

  it.each([
    ['a $cond whose branches read other things', cond('Wait', 'Stop'), 'join'],
    ['a template: the part is not in the filled text', { $template: 'Join ${/n} clips' }, 'merge'],
    [
      'a template: the hole itself is not what a person reads',
      { $template: 'Join ${/n} clips' },
      '${/n}',
    ],
    [
      'a template: a bare hole reads its own value, not another',
      { $template: 'Join ${n} clips' },
      'join 4 clips',
    ],
    [
      'a template: a missing value is empty, not its name',
      { $template: 'Go${/missing}!' },
      'missing',
    ],
    [
      'an incomplete $cond is a plain object, not a label',
      { $cond: { $state: '/flag' }, $then: 'Join' },
      'join',
    ],
    [
      'a $cond beside a $template: the template is not read',
      cond('Wait', 'Stop', { $template: 'Join ${/n}' }),
      'join',
    ],
    // json-render reads the item and index markers (279-293) before a $cond or a $template. A repeat's item
    // or position is not known to the grader, so a value that carries one has no text, whatever sits beside it
    [
      'an $item marker beside a $template: the item, not the template',
      { $item: 'name', $template: 'Join' },
      'join',
    ],
    ['a $bindItem marker beside a $template', { $bindItem: 'name', $template: 'Join' }, 'join'],
    [
      'an $index marker beside a $template: a position, not text',
      { $index: true, $template: 'Join' },
      'join',
    ],
    ['an $item marker beside a $cond', cond('Join', 'Join', { $item: 'name' }), 'join'],
    [
      'an $item marker beside a $bindState marker: the item comes first',
      { $item: 'name', $bindState: '/x' },
      'join',
    ],
    [
      'an $index marker beside a $bindState marker: the position comes first',
      { $index: true, $bindState: '/x' },
      'join',
    ],
  ])('%s does not match', async (_name, label, part) => {
    expect(await failing(label, part)).toEqual(['described-1-button']);
  });

  it('a Text is read the same way: its own text, with the holes filled', async () => {
    const spec = await validated(appOf('Text', { $template: 'Count: ${/n}' }));
    const asks = (part: string) => describing(entryOf('Text', { label: part }));
    expect(failingNames(run(asks('count: 3'), spec))).toEqual([]);
    expect(failingNames(run(asks('count: 4'), spec))).toEqual(['described-1-text']);
  });

  it('the evidence stays fixed host text: the filled label never reaches it', async () => {
    const spec = await validated(appOf('Button', { $template: 'Join ${/n} clips' }));
    const found = result(
      run(describing(entryOf('Button', { label: 'join 3' })), spec),
      'described-1-button',
    );
    const missed = result(
      run(describing(entryOf('Button', { label: 'merge' })), spec),
      'described-1-button',
    );
    expect([found.pass, found.evidence]).toEqual([
      true,
      'an element has the described type, label, options, binding and press action',
    ]);
    expect([missed.pass, missed.evidence]).toEqual([
      false,
      'no free element has the described type, label, options, binding and press action',
    ]);
  });
});

describe('showsState reads a $cond before a $template, as json-render does', () => {
  const asksText = describing(entryOf('Text', { showsState: true }));
  const read = { $state: '/n' };

  it.each([
    // json-render resolves the $cond (core 0.19.0, dist/index.mjs 294-297) and never reaches the $template
    // (317-333): two fixed branches show no state, whatever the template beside them reads
    [
      'a $cond of two fixed branches, beside a $template with a hole',
      cond('some', 'none', { $template: 'Count: ${/n}' }),
      ['described-1-text'],
    ],
    // the control: a branch that reads state shows state, whatever the template beside it
    [
      'a $cond with a state branch, beside a $template with no hole',
      cond(read, 'none', { $template: 'Count' }),
      [],
    ],
    // an incomplete $cond is no $cond to json-render (253-255), so the template decides
    [
      'an incomplete $cond, beside a $template with a hole',
      { $cond: { $state: '/flag' }, $then: 'some', $template: 'Count: ${/n}' },
      [],
    ],
    [
      'an incomplete $cond, beside a $template with no hole',
      { $cond: { $state: '/flag' }, $then: 'some', $template: 'Count' },
      ['described-1-text'],
    ],
  ])('%s', async (_name, text, expected) => {
    expect(failingNames(run(asksText, await validated(appOf('Text', text))))).toEqual(expected);
  });
});

describe('showsState reads the repeat markers before a $cond or a $template, as json-render does', () => {
  const asksText = describing(entryOf('Text', { showsState: true }));
  const read = { $state: '/n' };

  it.each([
    // $index is a position, not a state value (283-285), and json-render returns it before it reaches the
    // $cond (294) or the $template (317): what sits beside it is never read
    [
      'an $index marker beside a $template with a hole',
      { $index: true, $template: 'Count: ${/n}' },
      ['described-1-text'],
    ],
    [
      'an $index marker beside a $cond with a state branch',
      cond(read, 'none', { $index: true }),
      ['described-1-text'],
    ],
    // $index (283) comes before $bindState (286)
    [
      'an $index marker beside a $bindState marker',
      { $index: true, $bindState: '/n' },
      ['described-1-text'],
    ],
    // an item is read from state (279-282, 289-293), whatever sits beside it
    ['an $item marker beside a $template with no hole', { $item: 'name', $template: 'Count' }, []],
    [
      'a $bindItem marker beside a $cond of two fixed branches',
      cond('some', 'none', { $bindItem: 'name' }),
      [],
    ],
    // $state (276) and $item (279) come before $index (283)
    ['a $state marker beside an $index marker', { $state: '/n', $index: true }, []],
    ['an $item marker beside an $index marker', { $item: 'name', $index: true }, []],
  ])('%s', async (_name, text, expected) => {
    expect(failingNames(run(asksText, await validated(appOf('Text', text))))).toEqual(expected);
  });
});
