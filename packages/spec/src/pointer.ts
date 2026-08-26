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

function isStateBinding(v: unknown): v is { $state: string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    '$state' in v &&
    typeof (v as { $state: unknown }).$state === 'string'
  );
}

/** Normalize a json-render path to a leading-slash RFC-6901 pointer. */
function toPointer(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

function collectFromProps(props: unknown, elementKey: string, out: BoundPointer[]): void {
  if (typeof props !== 'object' || props === null) return;
  for (const value of Object.values(props as Record<string, unknown>)) {
    if (isStateBinding(value)) {
      out.push({ pointer: toPointer(value.$state), elementKey, source: 'prop' });
    }
  }
}

/**
 * Walk a spec and collect every pointer the UI binds to: `$state` props,
 * `watch` state-path keys, and `repeat.statePath` (`on` is deliberately NOT
 * walked — its values are action bindings, not state pointers). The semantic
 * validator uses this to prove every binding resolves against spec.state.
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
