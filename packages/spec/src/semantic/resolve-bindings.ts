import { collectBoundPointers, getByPath } from '../pointer.js';
import type { Spec } from '../spec-types.js';
import type { SemanticIssue } from './semantic-types.js';

/**
 * Every bound pointer must resolve against spec.state. A binding that reads a
 * key absent from state is a wires-to-nothing defect (renders blank, never errors
 * at runtime — so structural validation misses it).
 */
export function resolveBindings(spec: Spec): readonly SemanticIssue[] {
  const state = spec.state ?? {};
  const issues: SemanticIssue[] = [];
  for (const bound of collectBoundPointers(spec)) {
    if (getByPath(state, bound.pointer) === undefined) {
      issues.push({
        severity: 'error',
        code: 'unresolved_binding',
        message: `Binding "${bound.pointer}" on element "${bound.elementKey}" does not resolve against state.`,
        elementKey: bound.elementKey,
        pointer: bound.pointer,
      });
    }
  }
  return issues;
}
