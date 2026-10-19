import { resolvePointer } from '@minitui/catalog';
import { JsonObjectSchema } from '@minitui/types';
import { collectBoundPointers } from '../pointer.js';
import type { Spec } from '../spec-types.js';
import type { SemanticIssue } from './semantic-types.js';

/**
 * Every bound pointer must resolve against spec.state. A binding that reads a
 * key absent from state is a wires-to-nothing defect (renders blank, never errors
 * at runtime — so structural validation misses it). The state is parsed, not cast, and a pointer is
 * followed over own properties and strict array indices only (the catalog's resolver), so `/toString`
 * and `/rows/01` do not resolve. A `repeat` target must be a list.
 */
export function resolveBindings(spec: Spec): readonly SemanticIssue[] {
  const parsed = JsonObjectSchema.safeParse(spec.state ?? {});
  const state = parsed.success ? parsed.data : {};
  const issues: SemanticIssue[] = [];
  for (const bound of collectBoundPointers(spec)) {
    const target = resolvePointer(state, bound.pointer);
    const notAList = bound.source === 'repeat' && target !== undefined && !Array.isArray(target);
    if (target === undefined || notAList) {
      issues.push({
        severity: 'error',
        code: 'unresolved_binding',
        message: notAList
          ? `Binding "${bound.pointer}" on element "${bound.elementKey}" does not resolve to a list in state.`
          : `Binding "${bound.pointer}" on element "${bound.elementKey}" does not resolve against state.`,
        elementKey: bound.elementKey,
        pointer: bound.pointer,
      });
    }
  }
  return issues;
}
