import { describe, it, expect } from 'vitest';
import { checkElementTree, hasCanonicalKeys, MAX_ELEMENT_DEPTH } from '@minitui/catalog';
import {
  canonical,
  drive,
  isRecord,
  lastEnvelope,
  patchLines,
  setAt,
  type Json,
} from './support/driver.js';

// A chain of Box elements: e0 is the root and each element lists the next.
function chain(length: number): Json {
  const elements: Json = {};
  for (let i = 0; i < length; i++) {
    elements[`e${i}`] = {
      type: 'Box',
      props: {},
      ...(i + 1 < length ? { children: [`e${i + 1}`] } : {}),
    };
  }
  return { root: 'e0', elements, state: {} };
}

// Send the same bad text on every pass and return the last envelope.
async function refusal(spec: Json) {
  const run = await drive({ replies: [patchLines(spec)] });
  expect(run.thrown).toBeUndefined();
  return { run, envelope: lastEnvelope(run) };
}

function changed(edit: (spec: Json) => void): Json {
  const spec = canonical();
  edit(spec);
  return spec;
}

describe('the tree helpers come from the catalog package', () => {
  it('exports the depth bound and the two functions', () => {
    expect(MAX_ELEMENT_DEPTH).toBe(64);
    expect(typeof checkElementTree).toBe('function');
    expect(typeof hasCanonicalKeys).toBe('function');
  });
});

describe('children form a tree', () => {
  const refused: Array<[string, Json, string[]]> = [
    [
      'an element that lists itself',
      changed((s) => setAt(s, ['elements', 'screen', 'children'], ['screen'])),
      ['empty_spec'],
    ],
    [
      'a two-element cycle',
      changed((s) => {
        setAt(s, ['elements', 'a'], { type: 'Box', props: {}, children: ['b'] });
        setAt(s, ['elements', 'b'], { type: 'Box', props: {}, children: ['a'] });
        setAt(s, ['elements', 'screen', 'children'], ['a']);
      }),
      ['empty_spec'],
    ],
    [
      'a child listed by two parents',
      changed((s) => {
        setAt(s, ['elements', 'one'], { type: 'Box', props: {}, children: ['shared'] });
        setAt(s, ['elements', 'two'], { type: 'Box', props: {}, children: ['shared'] });
        setAt(s, ['elements', 'shared'], { type: 'Box', props: {} });
        setAt(s, ['elements', 'screen', 'children'], ['one', 'two']);
      }),
      ['empty_spec'],
    ],
    [
      'a child listed twice under one parent',
      changed((s) => {
        setAt(s, ['elements', 'twice'], { type: 'Box', props: {} });
        setAt(s, ['elements', 'screen', 'children'], ['twice', 'twice']);
      }),
      ['empty_spec'],
    ],
    ['a chain of 65 elements', chain(65), ['empty_spec']],
    ['a chain of 5,000 elements', chain(5000), ['empty_spec']],
  ];

  it.each(refused)('%s is refused on the structural list', async (_name, spec, codes) => {
    const { envelope } = await refusal(spec);
    expect(envelope.structural.map((i) => i.code)).toEqual(codes);
    expect(envelope.catalog).toEqual([]);
    expect(envelope.semantic).toEqual([]);
  });

  it('a root that names no element, spelled as an inherited name, is root_not_found', async () => {
    const { envelope } = await refusal(changed((s) => setAt(s, ['root'], 'constructor')));
    expect(envelope.structural.map((i) => i.code)).toContain('root_not_found');
    expect(envelope.catalog).toEqual([]);
    expect(envelope.semantic).toEqual([]);
  });

  it('a child that names no element, spelled as an inherited name, is missing_child on the parent', async () => {
    const { envelope } = await refusal(
      changed((s) => setAt(s, ['elements', 'screen', 'children'], ['toString'])),
    );
    const issue = envelope.structural.find((i) => i.code === 'missing_child');
    expect(issue?.elementKey).toBe('screen');
    expect(envelope.catalog).toEqual([]);
    expect(envelope.semantic).toEqual([]);
  });

  it('a chain of 64 elements is accepted with no regeneration', async () => {
    const run = await drive({ replies: [patchLines(chain(64))] });
    expect(run.result?.ok).toBe(true);
    expect(run.regenerations).toBe(0);
  });

  it('an element nobody lists is accepted', async () => {
    const spec = changed((s) => setAt(s, ['elements', 'spare'], { type: 'Box', props: {} }));
    const run = await drive({ replies: [patchLines(spec)] });
    expect(run.result?.ok).toBe(true);
    expect(run.regenerations).toBe(0);
  });

  it('an element with repeat that is listed once is accepted', async () => {
    const spec = changed((s) => {
      setAt(s, ['elements', 'rows'], {
        type: 'Box',
        props: {},
        repeat: { statePath: '/inputs' },
      });
      const screen = isRecord(s.elements) ? s.elements.screen : undefined;
      const kids = isRecord(screen) && Array.isArray(screen.children) ? screen.children : [];
      setAt(s, ['elements', 'screen', 'children'], [...kids, 'rows']);
    });
    const run = await drive({ replies: [patchLines(spec)] });
    expect(run.result?.ok).toBe(true);
    expect(run.regenerations).toBe(0);
  });
});
