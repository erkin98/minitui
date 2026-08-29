import { getByPath } from '../pointer.js';
import { bindingsOf } from './walk-bindings.js';
import type { Spec, UIElement } from '../spec-types.js';
import type { CapabilityProvider } from '../capability-port.js';
import type { SemanticIssue } from './semantic-types.js';

const CAPABILITY_PROPS = ['encoder', 'codec', 'filter'] as const;
type CapProp = (typeof CAPABILITY_PROPS)[number];

/**
 * Every STATICALLY-KNOWABLE candidate string a capability value can resolve to: a literal,
 * a one-way `$state` or two-way `$bindState` read, and BOTH branches of a complete `$cond`
 * (the renderer picks one at dispatch, so validation must check both). Dynamic forms
 * (`$template`/`$item`/`$bindItem`) resolve to a runtime value the gate cannot know at
 * generation time and are honestly skipped, not rejected — matching the renderer's own
 * marker guards (a mistyped marker resolves to nothing checkable here).
 */
function resolveCapabilityValues(raw: unknown, state: Record<string, unknown>): readonly string[] {
  if (typeof raw === 'string') return [raw];
  if (typeof raw !== 'object' || raw === null) return [];
  const record = raw as Record<string, unknown>;
  if (typeof record.$state === 'string') {
    const v = getByPath(state, record.$state);
    return typeof v === 'string' ? [v] : [];
  }
  if (typeof record.$bindState === 'string') {
    const v = getByPath(state, record.$bindState);
    return typeof v === 'string' ? [v] : [];
  }
  if ('$cond' in record && '$then' in record && '$else' in record) {
    return [
      ...resolveCapabilityValues(record.$then, state),
      ...resolveCapabilityValues(record.$else, state),
    ];
  }
  return [];
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
    for (const value of resolveCapabilityValues(props?.[prop], state)) yield { prop, value };
  }
  for (const binding of bindingsOf(element)) {
    const params = (binding as { params?: unknown }).params;
    if (typeof params !== 'object' || params === null) continue;
    for (const prop of CAPABILITY_PROPS) {
      for (const value of resolveCapabilityValues(
        (params as Record<string, unknown>)[prop],
        state,
      )) {
        yield { prop, value };
      }
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
