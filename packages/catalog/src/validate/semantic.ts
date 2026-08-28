import { z, type ZodType } from 'zod';
import type { JsonValue } from '@minitui/types';
import type { AppSpec, SpecElement } from '../contract/spec.js';
import type { MinituiCatalog } from '../define-catalog.js';
import { applyResourceTemplate, resolvePointer } from '../contract/action-kind.js';
import { collectBindings, actionNamesOf } from '../allowlist.js';

export type SemanticIssue = {
  readonly code:
    | 'danger-without-confirm'
    | 'bad-binding'
    | 'bad-props'
    | 'off-grammar-operator'
    | 'missing-required-prop';
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

// The prop-value expression operators the agent may emit — the taught marker set
// the renderer resolves. Everything else is off the no-code grammar; notably
// $computed, which calls a registered function, is rejected outright.
const ALLOWED_PROP_OPERATORS: ReadonlySet<string> = new Set([
  '$state',
  '$bindState',
  '$path',
  '$template',
  '$item',
  '$index',
  '$cond',
  '$bindItem',
]);
// A conditional expression's branch containers — walk into these; they are not operators.
const COND_BRANCH_KEYS: ReadonlySet<string> = new Set(['$then', '$else']);
// Single-value markers the renderer reads directly from a scalar payload; it does
// not resolve nested prop expressions inside them, so their payload is not walked.
const TERMINAL_MARKERS: ReadonlySet<string> = new Set([
  '$state',
  '$bindState',
  '$path',
  '$template',
  '$item',
  '$index',
  '$bindItem',
]);

// True when a prop value carries a function-call operator or any unknown
// $-operator at ANY depth. Mirrors how the renderer resolves prop values: it
// recurses into conditional branches, plain objects, and arrays and CALLS the
// function a $computed names, so the gate fails closed on such an operator
// wherever it hides. A conditional resolves only its chosen branch (its condition
// is a separate visibility grammar checked elsewhere), so only the branches are
// walked. A terminal marker normally holds a scalar the renderer reads directly;
// if its payload is instead a non-scalar (a mistyped marker), the renderer does not
// treat it as a marker and recurses into it, so the gate walks that payload too —
// only a scalar payload terminates safe, and the dead-code siblings of a scalar
// marker are not walked.
function hasOffGrammarOperator(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasOffGrammarOperator);
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const markerKeys = Object.keys(record).filter((k) => k.startsWith('$'));
  // Any $-key outside the taught set (or a conditional branch container) is
  // off-grammar. $computed is deliberately excluded from the set so a function-call
  // operator fails closed here.
  for (const markerKey of markerKeys) {
    if (!ALLOWED_PROP_OPERATORS.has(markerKey) && !COND_BRANCH_KEYS.has(markerKey)) return true;
  }
  if ('$cond' in record) {
    return hasOffGrammarOperator(record.$then) || hasOffGrammarOperator(record.$else);
  }
  const terminalKeys = markerKeys.filter((markerKey) => TERMINAL_MARKERS.has(markerKey));
  if (terminalKeys.length > 0) {
    // A scalar terminal-marker payload is read directly and terminates safe; a
    // non-scalar payload is a mistype the renderer recurses into, so walk it. The
    // marker's siblings are dead code once the marker resolves — not walked.
    return terminalKeys.some((markerKey) => {
      const payload = record[markerKey];
      return typeof payload === 'object' && payload !== null && hasOffGrammarOperator(payload);
    });
  }
  return Object.values(record).some(hasOffGrammarOperator);
}

// Reject any prop whose value carries an off-grammar expression operator.
function collectOffGrammarOperators(
  props: SpecElement['props'],
  key: string,
): readonly SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  for (const [propKey, value] of Object.entries(props)) {
    if (hasOffGrammarOperator(value)) {
      issues.push({
        code: 'off-grammar-operator',
        elementKey: key,
        message: `Prop "${propKey}" on "${key}" uses an off-grammar expression operator — only the taught state, binding, and conditional markers are allowed.`,
      });
    }
  }
  return issues;
}

// Reject any action-binding param whose value carries an off-grammar expression
// operator. Params resolve through the same resolvePropValue path as props at
// dispatch, which EXECUTES a $computed function — so a function-call or unknown
// $-operator hidden in a param must fail closed here, not run at press.
function collectParamOffGrammar(
  params: Readonly<Record<string, JsonValue>>,
  key: string,
): readonly SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  for (const [paramKey, value] of Object.entries(params)) {
    if (hasOffGrammarOperator(value)) {
      issues.push({
        code: 'off-grammar-operator',
        elementKey: key,
        message: `Action param "${paramKey}" on "${key}" uses an off-grammar expression operator — only the taught state, binding, and conditional markers are allowed.`,
      });
    }
  }
  return issues;
}

// A schema key is content-required (must be present in a spec) only when its field
// accepts neither undefined nor null and carries no default — genuinely required
// content the renderer cannot fill. isOptional() is true for an optional OR a
// defaulted field, so a nullable-required or defaulted key is legitimately omittable
// (the std styling props are all omittable this way) and is never flagged.
function isContentRequired(field: unknown): boolean {
  return field instanceof z.ZodType && !field.isOptional() && !(field instanceof z.ZodNullable);
}

// Flag a content-required prop the spec omits. Presence is read off the RAW props
// (Object.hasOwn) BEFORE dynamic markers are blanked, so a required prop supplied
// as a { $state } binding still counts as present.
function collectMissingRequired(
  schema: ZodType,
  props: SpecElement['props'],
  typeName: string,
  key: string,
): readonly SemanticIssue[] {
  if (!(schema instanceof z.ZodObject)) return [];
  const issues: SemanticIssue[] = [];
  for (const [propKey, field] of Object.entries(schema.shape)) {
    if (isContentRequired(field) && !Object.hasOwn(props, propKey)) {
      issues.push({
        code: 'missing-required-prop',
        elementKey: key,
        message: `Prop "${propKey}" is required by "${typeName}" but the spec omits it.`,
      });
    }
  }
  return issues;
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
    if (compDef !== undefined) {
      if (!checkProps(compDef.props, el.props).success) {
        issues.push({
          code: 'bad-props',
          elementKey: key,
          message: `Props for "${el.type}" failed the component schema (unknown or mistyped prop).`,
        });
      }
      // Genuinely-required content (a non-nullable, default-less prop) the spec
      // omits — a nullable-required or defaulted std styling prop stays omittable.
      issues.push(...collectMissingRequired(compDef.props, el.props, el.type, key));
    }

    // No-code moat: reject a function-call or unknown expression operator anywhere
    // in a prop value, independent of the component schema (blanked markers pass it).
    issues.push(...collectOffGrammarOperators(el.props, key));

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
      // No-code moat: an action param feeds the renderer's resolveActionParam →
      // resolvePropValue at dispatch, which executes a $computed function — reject a
      // function-call or unknown expression operator in a param, fail closed.
      issues.push(...collectParamOffGrammar(binding.params ?? {}, key));

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
