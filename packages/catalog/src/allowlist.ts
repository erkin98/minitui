import type { ActionBinding, AppSpec, SpecElement } from './contract/spec.js';
import type { MinituiCatalog } from './define-catalog.js';

export type AllowlistIssue = {
  readonly code:
    | 'unknown-component'
    | 'unknown-action'
    | 'off-grammar-callback'
    | 'malformed-binding';
  readonly elementKey: string;
  readonly offending: string;
  readonly message: string;
};

// True for a non-null object event map (el.on / el.watch). Untrusted input that
// json-render never value-checks can arrive null or non-object; only an object
// map carries bindings to gather. Per-binding validity is checked by the callers.
function isEventMap(
  group: unknown,
): group is Readonly<Record<string, ActionBinding | readonly ActionBinding[]>> {
  return group !== null && typeof group === 'object';
}

// Flatten every ActionBinding on an element: all on[event] entries plus all
// watch[path] entries (each value may be one binding or an array). Shared with
// validate/semantic.ts so both gates walk the identical binding surface. A
// null/non-object event map yields nothing; a null/non-object binding VALUE is
// yielded as-is so the callers can reject it as malformed rather than crashing.
export function collectBindings(el: SpecElement): readonly ActionBinding[] {
  const out: ActionBinding[] = [];
  for (const group of [el.on, el.watch]) {
    if (!isEventMap(group)) continue;
    // Each on[event] / watch[path] value is one binding or an array of them;
    // flat() flattens that one-level union to a typed ActionBinding[] (Array.isArray
    // widens a readonly-array branch to any[], flat() keeps the element type).
    out.push(...Object.values(group).flat());
  }
  return out;
}

// The action name a binding dispatches. @minitui/types's ActionBinding is
// .strict() with no onSuccess/onError (json-render's own ActionBinding has
// both) — the wire contract drops both chained-follow-up fields entirely
// rather than leaving them for a scanner to catch, so there is exactly one
// action name per binding. Kept as a single-element array so callers
// (rejectOffCatalog, checkSemantics) don't special-case the shape.
export function actionNamesOf(binding: ActionBinding): readonly string[] {
  return [binding.action];
}

/**
 * Generation-time enforcement point: reject any off-catalog component type or
 * action name BEFORE render. Both checks are RE-IMPLEMENTED here for one unified
 * AllowlistIssue shape — NOT delegated to base.validate(). json-render's z.enum
 * over componentNames could reject unknown component types, but its spec zod has
 * no action grammar at all (the net-new gap), so this walks every on/watch
 * binding in a single pass. Names are checked against catalog.actionNames ONLY:
 * a std name the catalog did not register (e.g. `exit`) is off-catalog. Fail
 * closed, no implicit std union. ActionBinding (@minitui/types, .strict()) has
 * no onSuccess/onError chain to walk — the wire contract drops both so a
 * chained follow-up can never dodge this allowlist by riding an unchecked field.
 */
export function rejectOffCatalog(
  spec: AppSpec,
  catalog: MinituiCatalog,
): readonly AllowlistIssue[] {
  const components = new Set(catalog.componentNames);
  const actions = new Set(catalog.actionNames);
  const issues: AllowlistIssue[] = [];

  // SpecElement has no inline `key` (identity is the map key — json-render's
  // keyed-map UIElement, not the array-form FlatElement) — read it off the entry.
  for (const [key, el] of Object.entries(spec.elements)) {
    if (!components.has(el.type)) {
      issues.push({
        code: 'unknown-component',
        elementKey: key,
        offending: el.type,
        message: `Component "${el.type}" is not in catalog "${catalog.id}".`,
      });
    }
    for (const binding of collectBindings(el)) {
      // A null/non-object binding value (untrusted input json-render never
      // value-checks) would crash the reads below. Fail closed with a repromptable
      // issue rather than throwing out of the gate's no-throw contract.
      const raw: unknown = binding;
      if (raw === null || typeof raw !== 'object') {
        issues.push({
          code: 'malformed-binding',
          elementKey: key,
          offending: String(raw),
          message: `Binding on "${key}" is not an action object — malformed; rejected (fail closed).`,
        });
        continue;
      }
      // Defense-in-depth: the frozen action grammar has NO onSuccess/onError/confirm
      // (@minitui/types's ActionBinding is .strict() without them). json-render's
      // own binding EXECUTES onSuccess.set (ungated state write) + onSuccess.action
      // (chained secondary action) and reads confirm as consent text. The model
      // stream is never runtime-parsed against the .strict() type, so a
      // model-authored callback or a spec-authored confirm dialog rides through as
      // an excess key. This walk REJECTS the off-grammar construct at generation
      // time (repromptable): a chained ON-catalog action, its ungated set write, and
      // agent-authored consent text are all off the frozen grammar (consent is
      // host-resolved, never taken from the model). Object.hasOwn reads the runtime
      // key the strict wire type deliberately omits (no cast).
      for (const callback of ['onSuccess', 'onError', 'confirm'] as const) {
        if (Object.hasOwn(binding, callback)) {
          issues.push({
            code: 'off-grammar-callback',
            elementKey: key,
            offending: callback,
            message: `Binding on "${key}" carries "${callback}" — off the frozen action grammar; consent and chained callbacks are host-owned, so it is rejected here (fail closed).`,
          });
        }
      }
      for (const name of actionNamesOf(binding)) {
        if (!actions.has(name)) {
          issues.push({
            code: 'unknown-action',
            elementKey: key,
            offending: name,
            message: `Action "${name}" is not in catalog "${catalog.id}".`,
          });
        }
      }
    }
  }
  return issues;
}

/**
 * The "throw naming the type" primitive behind the render-time enforcement
 * point. json-render's Renderer resolves `registry[type] ?? fallback` and,
 * when BOTH are missing, console.warns and returns null — a SILENT no-op.
 * Omitting a fallback is therefore FAIL-OPEN — but wiring this function AS the
 * fallback ComponentRenderer prop is ALSO fail-open: every resolved Component
 * (catalog component or fallback alike) renders inside an ElementErrorBoundary,
 * which swallows any render-phase throw to a console.error + a null re-render —
 * functionally the same silent outcome as the native miss path. renderer-ink's
 * pre-render walk MAY call this function from a SYNCHRONOUS walk that runs
 * BEFORE React renders (outside any component tree, so no boundary can intercept
 * it) — never from inside the fallback prop's own render. The walk MAY
 * equivalently throw inline; this is the reusable primitive (a shared message),
 * not a mandated call site.
 */
export function throwingFallback(componentType: string): never {
  throw new Error(
    `Off-catalog component "${componentType}" reached the renderer — ` +
      `the catalog allowlist failed closed (render-time enforcement point).`,
  );
}
