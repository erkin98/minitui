import { boundIssue } from '../sanitize/index.js';

/** Deepest level an element may sit at. The root element is level 1. */
export const MAX_ELEMENT_DEPTH = 64;

export type ElementTreeIssue = {
  readonly code: 'missing-root' | 'missing-child' | 'not-a-tree' | 'too-deep';
  /** Where it was found: the parent for a child problem, '' for a missing root. */
  readonly elementKey: string;
  readonly message: string;
};

type Frame = { readonly key: string; readonly depth: number; readonly parent: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const missingRoot = (message: string): readonly ElementTreeIssue[] => [
  { code: 'missing-root', elementKey: '', message },
];

// Pushes the children of one element, reporting each child that is not a string or not an own key of
// `elements`. Lookups use Object.hasOwn so an inherited name such as `toString` is not an element.
function expand(
  frame: Frame,
  element: unknown,
  elements: Record<string, unknown>,
  stack: Frame[],
  issues: ElementTreeIssue[],
): void {
  if (!isRecord(element) || !Object.hasOwn(element, 'children')) return;
  const children = element.children;
  if (!Array.isArray(children)) {
    issues.push({
      code: 'not-a-tree',
      elementKey: frame.key,
      message: `Element "${frame.key}" has children that is not a list.`,
    });
    return;
  }
  for (const child of children as unknown[]) {
    if (typeof child !== 'string') {
      issues.push({
        code: 'not-a-tree',
        elementKey: frame.key,
        message: `Element "${frame.key}" lists a child that is not an element name.`,
      });
    } else if (!Object.hasOwn(elements, child)) {
      issues.push({
        code: 'missing-child',
        elementKey: frame.key,
        message: `Element "${frame.key}" lists the child "${child}", which is not in elements.`,
      });
    } else {
      stack.push({ key: child, depth: frame.depth + 1, parent: frame.key });
    }
  }
}

function walk(root: string, elements: Record<string, unknown>): readonly ElementTreeIssue[] {
  const issues: ElementTreeIssue[] = [];
  const reached = new Set<string>();
  const stack: Frame[] = [{ key: root, depth: 1, parent: '' }];
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    if (reached.has(frame.key)) {
      issues.push({
        code: 'not-a-tree',
        elementKey: frame.parent,
        message: `Element "${frame.key}" is reached more than once (a cycle or a shared child).`,
      });
    } else {
      reached.add(frame.key);
      if (frame.depth > MAX_ELEMENT_DEPTH) {
        issues.push({
          code: 'too-deep',
          elementKey: frame.key,
          message: `Element "${frame.key}" sits deeper than ${MAX_ELEMENT_DEPTH} levels.`,
        });
      } else {
        expand(frame, elements[frame.key], elements, stack, issues);
      }
    }
  }
  return issues;
}

/** The one tree rule for a spec's `children` graph. Never throws; linear in the element count. */
export function checkElementTree(spec: unknown): readonly ElementTreeIssue[] {
  return treeIssues(spec).map(boundIssue);
}

function treeIssues(spec: unknown): readonly ElementTreeIssue[] {
  try {
    if (!isRecord(spec)) return missingRoot('The spec is not an object, so it has no root.');
    const { root, elements } = spec;
    if (typeof root !== 'string' || !isRecord(elements) || !Object.hasOwn(elements, root)) {
      return missingRoot('The spec has no root that names one of its elements.');
    }
    return walk(root, elements);
  } catch {
    return missingRoot('The spec could not be read.');
  }
}
