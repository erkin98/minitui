import { getByPath } from '@json-render/core';
import type { Spec } from './spec-types.js';

// Re-export the adopted RFC-6901 reader verbatim.
export { getByPath };

export interface BoundPointer {
  /** RFC-6901 JSON-Pointer into spec.state (e.g. "/codec"). */
  readonly pointer: string;
  /** The element key that carries this binding. */
  readonly elementKey: string;
  /** Where the binding was found. `on` is excluded: its values are action bindings, not state pointers. */
  readonly source: 'prop' | 'watch' | 'repeat';
}

/**
 * The state-pointer a prop value carries, or undefined. Both one-way (`$state`)
 * and two-way (`$bindState`) markers hold a JSON-Pointer into the state document,
 * so both count — the value control the frozen catalog uses (FilePicker, Select)
 * binds two-way. Repeat-item / conditional / template markers ($item, $index,
 * $cond, $template) are NOT state pointers and are intentionally not treated here.
 */
function stateBindingPointer(v: unknown): string | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.$state === 'string') return o.$state;
  if (typeof o.$bindState === 'string') return o.$bindState;
  return undefined;
}

/** Normalize a json-render path to a leading-slash RFC-6901 pointer. */
function toPointer(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * Collect every state-binding pointer anywhere inside a prop value. A binding can
 * sit at the top of props or nested inside an object or array (a repeated row's
 * label, a config sub-object), so the walk recurses; a marker is a leaf (its
 * pointer is collected and it is not descended into).
 */
function collectFromProps(value: unknown, elementKey: string, out: BoundPointer[]): void {
  const pointer = stateBindingPointer(value);
  if (pointer !== undefined) {
    out.push({ pointer: toPointer(pointer), elementKey, source: 'prop' });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFromProps(item, elementKey, out);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectFromProps(v, elementKey, out);
    }
  }
}

/**
 * Walk a spec and collect every pointer the UI binds to: `$state`/`$bindState`
 * props (at any nesting depth), `watch` state-path keys, and `repeat.statePath`
 * (`on` is deliberately NOT walked — its values are action bindings, not state
 * pointers). The semantic validator uses this to prove every binding resolves
 * against spec.state.
 */
export function collectBoundPointers(spec: Spec): readonly BoundPointer[] {
  const out: BoundPointer[] = [];
  for (const [key, element] of Object.entries(spec.elements)) {
    collectFromProps(element.props, key, out);
    if (element.repeat?.statePath) {
      out.push({ pointer: toPointer(element.repeat.statePath), elementKey: key, source: 'repeat' });
    }
    if (element.watch) {
      for (const path of Object.keys(element.watch)) {
        out.push({ pointer: toPointer(path), elementKey: key, source: 'watch' });
      }
    }
  }
  return out;
}
