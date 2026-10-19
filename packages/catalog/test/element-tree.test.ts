import { describe, it, expect } from 'vitest';
import { checkElementTree, MAX_ELEMENT_DEPTH } from '../src/validate/element-tree.js';

type Elements = Record<
  string,
  { type: string; props: object; children?: unknown; repeat?: object }
>;
const el = (children?: unknown): Elements[string] => ({
  type: 'Box',
  props: {},
  ...(children === undefined ? {} : { children }),
});
const tree = (root: string, elements: Elements): unknown => ({ root, elements });

// a straight chain of `length` elements named e1 .. e<length>, rooted at e1
function chain(length: number): unknown {
  const elements: Elements = {};
  for (let i = 1; i <= length; i++) {
    elements[`e${i}`] = el(i < length ? [`e${i + 1}`] : undefined);
  }
  return tree('e1', elements);
}

const codesOf = (spec: unknown): string[] => checkElementTree(spec).map((issue) => issue.code);

describe('checkElementTree', () => {
  it('reports a spec without a root at the empty element key', () => {
    const issues = checkElementTree({ elements: { a: el() } });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('missing-root');
    expect(issues[0]?.elementKey).toBe('');
  });

  it('does not take an inherited name for the root', () => {
    expect(codesOf(tree('constructor', {}))).toEqual(['missing-root']);
  });

  it('does not take an inherited name for a child', () => {
    const issues = checkElementTree(tree('a', { a: el(['toString']) }));
    expect(issues.map((i) => i.code)).toEqual(['missing-child']);
    expect(issues[0]?.elementKey).toBe('a');
  });

  it('refuses an element that lists itself', () => {
    expect(codesOf(tree('a', { a: el(['a']) }))).toContain('not-a-tree');
  });

  it('refuses a two-element cycle', () => {
    expect(codesOf(tree('a', { a: el(['b']), b: el(['a']) }))).toContain('not-a-tree');
  });

  it('refuses a child listed by two parents', () => {
    const spec = tree('r', { r: el(['a', 'b']), a: el(['c']), b: el(['c']), c: el() });
    expect(codesOf(spec)).toContain('not-a-tree');
  });

  it('refuses a child listed twice by one parent', () => {
    expect(codesOf(tree('a', { a: el(['b', 'b']), b: el() }))).toContain('not-a-tree');
  });

  it('refuses children that is not an array', () => {
    expect(codesOf(tree('a', { a: el('b'), b: el() }))).toContain('not-a-tree');
  });

  it('refuses a child that is not a string', () => {
    expect(codesOf(tree('a', { a: el([1]) }))).toContain('not-a-tree');
  });

  it('accepts a chain at the depth bound and refuses one past it', () => {
    expect(MAX_ELEMENT_DEPTH).toBe(64);
    expect(checkElementTree(chain(64))).toEqual([]);
    expect(codesOf(chain(65))).toEqual(['too-deep']);
  });

  it('allows an element nobody lists', () => {
    expect(checkElementTree(tree('a', { a: el(), orphan: el() }))).toEqual([]);
  });

  it.each([[null], [7], [[]]])(
    'returns one missing-root issue for %j and does not throw',
    (value) => {
      expect(codesOf(value)).toEqual(['missing-root']);
    },
  );

  it('leaves an element that carries repeat alone', () => {
    const spec = tree('a', {
      a: el(['b']),
      b: { ...el(), repeat: { statePath: '/rows', key: 'id' } },
    });
    expect(checkElementTree(spec)).toEqual([]);
  });

  it('answers at once for a graph where each element lists the next one twice', () => {
    const elements: Elements = {};
    for (let i = 1; i <= 20; i++) {
      elements[`e${i}`] = el(i < 20 ? [`e${i + 1}`, `e${i + 1}`] : undefined);
    }
    expect(codesOf(tree('e1', elements))).toContain('not-a-tree');
  });
});

describe('checkElementTree issue text is clean and bounded', () => {
  const ESC = '\u001b';
  const withChild = (child: string, parent = 'a'): unknown =>
    tree(parent, { [parent]: el([child]) });

  it('returns no control byte for a child name carrying escape sequences', () => {
    const issues = checkElementTree(withChild(`${ESC}[31mred${ESC}]0;title\u0007`));
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.message).not.toMatch(/\p{Cc}/u);
      expect(issue.elementKey).not.toMatch(/\p{Cc}/u);
    }
  });

  it('cuts a very long child name and a very long parent name', () => {
    const issues = checkElementTree(withChild('c'.repeat(100_000), 'p'.repeat(100_000)));
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.message.length).toBeLessThanOrEqual(300);
      expect(issue.elementKey.length).toBeLessThanOrEqual(80);
    }
    expect(issues[0]?.message.endsWith('…')).toBe(true);
    expect(issues[0]?.elementKey.endsWith('…')).toBe(true);
  });

  it('returns short names whole', () => {
    const [issue] = checkElementTree(withChild('gone'));
    expect(issue?.message).toBe('Element "a" lists the child "gone", which is not in elements.');
    expect(issue?.elementKey).toBe('a');
  });
});
