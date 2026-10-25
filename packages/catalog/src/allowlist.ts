import { JsonValueSchema } from '@minitui/types';
import type { ActionBinding, AppSpec, SpecElement } from './contract/spec.js';
import type { MinituiCatalog } from './define-catalog.js';
import { boundIssue, hasCanonicalKeys } from './sanitize/index.js';

export type AllowlistIssue = {
  readonly code:
    | 'unknown-component'
    | 'unknown-action'
    | 'off-grammar-callback'
    | 'malformed-binding'
    | 'malformed-spec'
    | 'non-canonical-key'
    | 'watch-unsupported'
    | 'gate-internal-error';
  readonly elementKey: string;
  readonly offending: string;
  readonly message: string;
};

// What the shared screen can raise: codes both gate halves carry.
export type ScreenIssue = AllowlistIssue & {
  readonly code: 'malformed-spec' | 'malformed-binding' | 'non-canonical-key';
};

// Fixed text, no thrown value in it: a throw that escapes a walker becomes this one issue.
export const GATE_INTERNAL_ERROR_MESSAGE =
  'The validation gate failed internally, so the spec was refused (fail closed).';

// The only keys a binding may carry.
const BINDING_KEYS: ReadonlySet<string> = new Set(['action', 'params']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const screenIssue = (
  code: ScreenIssue['code'],
  elementKey: string,
  message: string,
): ScreenIssue => ({ code, elementKey, offending: '', message });

function screenBinding(binding: unknown, key: string): readonly ScreenIssue[] {
  if (!isRecord(binding)) {
    return [
      screenIssue(
        'malformed-binding',
        key,
        `Binding on "${key}" is not an action object — malformed; rejected (fail closed).`,
      ),
    ];
  }
  if (typeof binding.action !== 'string') {
    return [
      screenIssue(
        'malformed-binding',
        key,
        `Binding on "${key}" has an action that is not a name — malformed; rejected (fail closed).`,
      ),
    ];
  }
  if (Object.hasOwn(binding, 'params') && !isRecord(binding.params)) {
    return [
      screenIssue(
        'malformed-binding',
        key,
        `Binding on "${key}" has params that are not an object — malformed; rejected (fail closed).`,
      ),
    ];
  }
  return [];
}

// An event map (el.on / el.watch) is an object whose values are one binding or a list of them.
function screenEventMap(group: unknown, field: string, key: string): readonly ScreenIssue[] {
  if (!isRecord(group)) {
    return [
      screenIssue(
        'malformed-binding',
        key,
        `"${field}" on "${key}" is not an object of bindings — malformed; rejected (fail closed).`,
      ),
    ];
  }
  return Object.values(group).flatMap((entry) =>
    (Array.isArray(entry) ? (entry as unknown[]) : [entry]).flatMap((binding) =>
      screenBinding(binding, key),
    ),
  );
}

function screenElement(key: string, element: unknown): readonly ScreenIssue[] {
  if (!isRecord(element)) {
    return [
      screenIssue(
        'malformed-spec',
        key,
        `Element "${key}" is not an object — rejected (fail closed).`,
      ),
    ];
  }
  if (typeof element.type !== 'string') {
    return [
      screenIssue(
        'malformed-spec',
        key,
        `Element "${key}" has a type that is not a name — rejected (fail closed).`,
      ),
    ];
  }
  if (!isRecord(element.props)) {
    return [
      screenIssue(
        'malformed-spec',
        key,
        `Element "${key}" has props that are not an object — rejected (fail closed).`,
      ),
    ];
  }
  return ['on', 'watch'].flatMap((field) =>
    Object.hasOwn(element, field) ? screenEventMap(element[field], field, key) : [],
  );
}

/**
 * The screen both gate halves run first, on a value of any shape. It refuses a spec that is not a plain
 * JSON tree (a cycle, a value that appears in two places, nesting past the shared limit, a reserved
 * key), then a spec whose names would change if cleaned (the renderer reads the cleaned form, so the
 * gate must see the same names), then the shapes the walkers read. Exported to validate/semantic.ts,
 * not from the barrel.
 */
export function screenSpec(spec: unknown): readonly ScreenIssue[] {
  if (!JsonValueSchema.safeParse(spec).success) {
    return [
      screenIssue(
        'malformed-spec',
        '',
        'The spec is not a plain JSON tree (a cycle, a repeated or over-deep value, or a reserved key) — rejected (fail closed).',
      ),
    ];
  }
  if (!isRecord(spec) || !isRecord(spec.elements)) {
    return [
      screenIssue(
        'malformed-spec',
        '',
        'The spec has no elements object — rejected (fail closed).',
      ),
    ];
  }
  if (!hasCanonicalKeys(spec)) {
    return [
      screenIssue(
        'non-canonical-key',
        '',
        'An element key, prop name, event name or param name holds a control character or collides with another after cleaning — use plain names (fail closed).',
      ),
    ];
  }
  return Object.entries(spec.elements).flatMap(([key, element]) => screenElement(key, element));
}

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
  return allowlistIssues(spec, catalog).map(boundIssue);
}

function allowlistIssues(spec: AppSpec, catalog: MinituiCatalog): readonly AllowlistIssue[] {
  try {
    const screened = screenSpec(spec);
    return screened.length > 0 ? screened : rejectNames(spec, catalog);
  } catch {
    return [
      {
        code: 'gate-internal-error',
        elementKey: '',
        offending: '',
        message: GATE_INTERNAL_ERROR_MESSAGE,
      },
    ];
  }
}

// The name walk, run only on a spec the screen has passed.
function rejectNames(spec: AppSpec, catalog: MinituiCatalog): readonly AllowlistIssue[] {
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
    // The renderer has no implementation of state watchers, so a bound action would validate and
    // never fire. The screen has already shown the field is an object; any object is refused.
    if (Object.hasOwn(el, 'watch')) {
      issues.push({
        code: 'watch-unsupported',
        elementKey: key,
        offending: 'watch',
        message: `Element "${key}" uses "watch", which is not supported — bind the action to an event under \`on\` instead.`,
      });
    }
    for (const binding of collectBindings(el)) {
      // The frozen action grammar is exactly `action` and `params` (@minitui/types's ActionBinding
      // is .strict()). The model stream is never runtime-parsed against that type, so any other key
      // rides through as an excess key, and json-render's binding reader acts on some of them: it
      // EXECUTES onSuccess.set (an ungated state write) and onSuccess.action (a chained secondary
      // action) and reads confirm as consent text; a callableFrom would try to widen the action's
      // visibility class, which only the catalog author sets. This walk allows those two keys and
      // REJECTS every other own key at generation time (repromptable), whatever its name: consent
      // and chained callbacks are host-owned, never taken from the model.
      for (const field of Object.keys(binding)) {
        if (!BINDING_KEYS.has(field)) {
          issues.push({
            code: 'off-grammar-callback',
            elementKey: key,
            offending: field,
            message: `Binding on "${key}" carries "${field}" — only "action" and "params" are in the frozen action grammar; consent, callbacks and visibility are host-owned, so it is rejected here (fail closed).`,
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
