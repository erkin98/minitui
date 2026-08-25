import { z, type ZodType } from 'zod';
import type { JsonValue } from '@minitui/types';
import type { AppSpec, SpecElement } from '../contract/spec.js';
import type { MinituiCatalog } from '../define-catalog.js';
import { applyResourceTemplate, resolvePointer } from '../contract/action-kind.js';
import { collectBindings, actionNamesOf } from '../allowlist.js';

export type SemanticIssue = {
  readonly code: 'danger-without-confirm' | 'bad-binding' | 'bad-props';
  readonly elementKey: string;
  readonly message: string;
};

// json-render dynamic pointer refs: { $state: '/ptr' } (read) and
// { $bindState: '/ptr' } (two-way write-back). Both are pointers into the
// bound state document. $item/$index/$cond are repeat/conditional-scoped
// markers the renderer resolves — the gate skips their values but keeps their keys.
function stateRefPointer(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.$state === 'string') return v.$state;
  if (typeof v.$bindState === 'string') return v.$bindState;
  return undefined;
}

function isDynamicMarker(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return Object.keys(value).some((k) => k.startsWith('$'));
}

// Recursively collect every { $state } / { $bindState } pointer in a value.
// json-render's resolvePropValue recurses into plain objects and arrays, so
// nested refs are live grammar — walk them all.
function collectStateRefs(value: unknown, out: string[] = []): readonly string[] {
  const pointer = stateRefPointer(value);
  if (pointer !== undefined) {
    out.push(pointer);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStateRefs(v, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) collectStateRefs(v, out);
  }
  return out;
}

// A resourceTemplate still containing a ${/ptr} hole after resolution failed.
// ${/ptr} is minitui's HOST-side consent-template grammar (applyResourceTemplate)
// — json-render never resolves it, so only resourceTemplates are scanned for it.
function hasUnresolvedHole(text: string, state: JsonValue): boolean {
  return /\$\{\/[^}]*\}/.test(applyResourceTemplate(text, state));
}

// Validate the PRESENT props: for a Zod object, .partial() so omitted nullable
// keys don't false-positive (std defs require nullable keys present, specs omit
// them) while .strict()'s unknown-key rejection survives .partial() — an extra or
// mistyped prop still fails. Dynamic-marker values are blanked to undefined (the
// renderer resolves their runtime type) but their KEYS stay, so an UNKNOWN
// dynamic-valued key is still rejected. Non-object schemas fall back to a plain parse.
function checkProps(schema: ZodType, props: SpecElement['props']): { readonly success: boolean } {
  if (schema instanceof z.ZodObject) {
    const staticProps = Object.fromEntries(
      Object.entries(props).map(([k, v]) => [k, isDynamicMarker(v) ? undefined : v]),
    );
    return schema.partial().safeParse(staticProps);
  }
  return schema.safeParse(props);
}

// Action-level semantic checks for one bound action name: (1) a render-local
// action must NOT carry a danger permission — render-local never gates, so a
// dangerous render-local is a contradiction that would run un-gated; (2) the
// action's resourceTemplate ${/ptr} holes (the host-side consent grammar) must
// resolve against the bound state document. Extracted so checkSemantics stays
// under the cyclomatic-complexity ceiling.
function checkAction(
  actionName: string,
  catalog: MinituiCatalog,
  key: string,
  state: JsonValue,
): readonly SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  const kind = catalog.kindOf(actionName);
  const permission = catalog.permissionOf(actionName);

  if (kind === 'render-local' && permission?.danger === true) {
    issues.push({
      code: 'danger-without-confirm',
      elementKey: key,
      message: `Action "${actionName}" is render-local but carries a danger permission — it would run un-gated.`,
    });
  }

  if (permission !== undefined && hasUnresolvedHole(permission.resourceTemplate, state)) {
    issues.push({
      code: 'bad-binding',
      elementKey: key,
      message: `resourceTemplate for "${actionName}" has a binding that does not resolve against the bound state.`,
    });
  }
  return issues;
}

/**
 * Catalog-aware semantic checks the lenient core validator skips:
 * danger-without-confirm, unresolved bindings (dynamic { $state }/{ $bindState }
 * refs in props and action params + ${/ptr} holes in resourceTemplates), and
 * per-element strict props. Walks the SAME on/watch binding surface as the
 * allowlist (collectBindings/actionNamesOf). `state` is the bound state
 * document (the wire AppSpec is state-free; the data model rides
 * MiniAppSpec.state); composeValidation passes candidate.state through.
 */
export function checkSemantics(
  spec: AppSpec,
  catalog: MinituiCatalog,
  state: JsonValue,
): readonly SemanticIssue[] {
  const issues: SemanticIssue[] = [];

  // SpecElement has no inline `key` (identity is the map key — json-render's
  // keyed-map UIElement, not the array-form FlatElement) — read it off the entry.
  for (const [key, el] of Object.entries(spec.elements)) {
    // (3) strict props: validate present, static props against the component
    // schema. Std-derived defs carry json-render's all-nullable zod where a
    // nullable key is still REQUIRED-present; a spec legitimately omits most of
    // them and json-render fills defaults at render. So check the PRESENT props,
    // not absent ones. defineMinituiCatalog strictened these plain std objects to
    // .strict() at ingest, so an unknown/mistyped key still fails here just as on
    // a custom def.
    const compDef = catalog.componentDefs.get(el.type);
    if (compDef !== undefined && !checkProps(compDef.props, el.props).success) {
      issues.push({
        code: 'bad-props',
        elementKey: key,
        message: `Props for "${el.type}" failed the component schema (unknown or mistyped prop).`,
      });
    }

    // (2) bad binding: every { $state }/{ $bindState } pointer in props must
    // resolve against the bound state document (the gate's own `state` arg — the
    // wire AppSpec is state-free).
    for (const pointer of collectStateRefs(el.props)) {
      if (resolvePointer(state, pointer) === undefined) {
        issues.push({
          code: 'bad-binding',
          elementKey: key,
          message: `Prop binding "${pointer}" on "${key}" does not resolve against the bound state.`,
        });
      }
    }

    for (const binding of collectBindings(el)) {
      // (2) dynamic action params: { $state } refs must resolve (the gate
      // inspects dynamic params, not just action names).
      for (const pointer of collectStateRefs(binding.params ?? {})) {
        if (resolvePointer(state, pointer) === undefined) {
          issues.push({
            code: 'bad-binding',
            elementKey: key,
            message: `Action param binding "${pointer}" on "${key}" does not resolve against the bound state.`,
          });
        }
      }

      for (const actionName of actionNamesOf(binding)) {
        issues.push(...checkAction(actionName, catalog, key, state));
      }
    }
  }
  return issues;
}
