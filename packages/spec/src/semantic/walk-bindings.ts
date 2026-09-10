import type { ActionBinding } from '@json-render/core';
import type { UIElement } from '../spec-types.js';

/** A binding plus any action nested under its `onSuccess`/`onError` callbacks (all depths). */
function* withCallbacks(binding: ActionBinding): Iterable<ActionBinding> {
  yield binding;
  // onSuccess/onError are real ActionBinding fields; read them directly (a string-
  // index cast does not overlap the interface under strict TS). The spec is untrusted
  // agent JSON, so a callback's `action` is widened to unknown before the object guard
  // — a smuggled nested action object is still walked (defense-in-depth).
  for (const cb of [binding.onSuccess, binding.onError]) {
    if (cb && 'action' in cb) {
      const nested: unknown = cb.action;
      if (nested && typeof nested === 'object') yield* withCallbacks(nested as ActionBinding);
    }
  }
}

/**
 * Every `on`/`watch` action binding on an element (single or array form),
 * INCLUDING any secondary action nested under a json-render `onSuccess`/`onError`
 * callback. The adopted lib EXECUTES those nested actions for real, so a walk that
 * reads only the top-level binding is blind to a smuggled nested action. The
 * pre-render strip removes these callbacks before the gate as the primary close;
 * this recursion is the defense-in-depth so every binding-walking check
 * (capability, visibility) still inspects a nested action if the strip is bypassed.
 */
export function* bindingsOf(element: UIElement): Iterable<ActionBinding> {
  for (const group of [element.on, element.watch]) {
    if (!group) continue;
    for (const entry of Object.values(group)) {
      for (const b of Array.isArray(entry) ? entry : [entry]) {
        if (b && typeof b === 'object') yield* withCallbacks(b);
      }
    }
  }
}
