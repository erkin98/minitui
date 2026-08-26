import type { ActionBinding } from '@json-render/core';
import { getByPath } from '../pointer.js';
import type { Spec, UIElement } from '../spec-types.js';
import type { CapabilityProvider } from '../capability-port.js';
import type { SemanticIssue } from './semantic-types.js';

const CAPABILITY_PROPS = ['encoder', 'codec', 'filter'] as const;
type CapProp = (typeof CAPABILITY_PROPS)[number];

/** Resolve a capability value: a literal string, or a `$state`/`$bindState` binding read from state. */
function resolveCapabilityValue(raw: unknown, state: Record<string, unknown>): string | undefined {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && raw !== null) {
    // A capability value can arrive one-way ($state) or two-way ($bindState) —
    // the canonical catalog uses both, so resolve either binding form.
    if ('$state' in raw) {
      const v = getByPath(state, (raw as { $state: string }).$state);
      return typeof v === 'string' ? v : undefined;
    }
    if ('$bindState' in raw) {
      const v = getByPath(state, (raw as { $bindState: string }).$bindState);
      return typeof v === 'string' ? v : undefined;
    }
  }
  return undefined;
}

/**
 * Every `on`/`watch` action binding on an element (single or array form),
 * INCLUDING any secondary action nested under a json-render `onSuccess`/`onError`
 * callback. The adopted lib EXECUTES `onSuccess.action`/`onError.action` as a real
 * secondary action (core/actions.ts:216,232), so a walk that reads only the
 * top-level binding is blind to a smuggled nested action. prepareSpec
 * STRIPS these callbacks before the gate as the primary close; this recursion is
 * the defense-in-depth so every binding-walking check (capability, visibility)
 * still inspects a nested action if the strip is ever bypassed (moat: the
 * frozen-grammar seam).
 */
function* bindingsOf(element: UIElement): Iterable<ActionBinding> {
  for (const group of [element.on, element.watch]) {
    if (!group) continue;
    for (const entry of Object.values(group)) {
      for (const b of Array.isArray(entry) ? entry : [entry]) {
        if (b && typeof b === 'object') yield* withCallbacks(b);
      }
    }
  }
}

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
 * Every capability-named value an element carries: an `encoder`/`codec`/`filter`
 * ELEMENT PROP (the control's own value) AND the same-named key inside an
 * `on`/`watch` ActionBinding's `params` — the value that actually reaches exec.
 * The canonical MERGE_SPEC carries the codec ONLY under the merge Button's
 * `on.press.params.codec` (never an element `codec` prop), so scanning props
 * alone leaves the gate blind to the capability the action ships.
 */
function* capabilityValues(
  element: UIElement,
  state: Record<string, unknown>,
): Iterable<{ readonly prop: CapProp; readonly value: string }> {
  const props = element.props as Record<string, unknown> | undefined;
  for (const prop of CAPABILITY_PROPS) {
    const value = resolveCapabilityValue(props?.[prop], state);
    if (value !== undefined) yield { prop, value };
  }
  for (const binding of bindingsOf(element)) {
    const params = (binding as { params?: unknown }).params;
    if (typeof params !== 'object' || params === null) continue;
    for (const prop of CAPABILITY_PROPS) {
      const value = resolveCapabilityValue((params as Record<string, unknown>)[prop], state);
      if (value !== undefined) yield { prop, value };
    }
  }
}

/**
 * Check every encoder/codec/filter value against the LIVE capability set probed
 * from the local ffmpeg (`-encoders/-codecs/-filters`), scanning BOTH
 * element props AND action-binding params. Schema-valid "libvpx-vp99" still fails.
 */
export async function checkCapabilities(
  spec: Spec,
  caps: CapabilityProvider,
): Promise<readonly SemanticIssue[]> {
  const state = spec.state ?? {};
  const [encoders, codecs, filters] = await Promise.all([
    caps.listEncoders(),
    caps.listCodecs(),
    caps.listFilters(),
  ]);
  const live: Record<CapProp, ReadonlySet<string>> = {
    encoder: new Set(encoders),
    codec: new Set(codecs),
    filter: new Set(filters),
  };
  const issues: SemanticIssue[] = [];
  for (const [key, element] of Object.entries(spec.elements)) {
    for (const { prop, value } of capabilityValues(element, state)) {
      if (!live[prop].has(value)) {
        issues.push({
          severity: 'error',
          code: 'missing_capability',
          message: `${prop} "${value}" on element "${key}" is not supported by the local toolchain.`,
          elementKey: key,
        });
      }
    }
  }
  return issues;
}
