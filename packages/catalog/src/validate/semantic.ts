import { z, type ZodType } from 'zod';
import type { JsonValue } from '@minitui/types';
import type { AppSpec, SpecElement } from '../contract/spec.js';
import type { MinituiCatalog } from '../define-catalog.js';
import { standardComponentDefinitions } from '../schema-bridge.js';
import { boundIssue } from '../sanitize/index.js';
import { holePointersOf, resolvePointer } from '../contract/action-kind.js';
import {
  collectBindings,
  actionNamesOf,
  screenSpec,
  GATE_INTERNAL_ERROR_MESSAGE,
} from '../allowlist.js';

export type SemanticIssue = {
  readonly code:
    | 'danger-without-confirm'
    | 'bad-binding'
    | 'bad-props'
    | 'bad-params'
    | 'off-grammar-operator'
    | 'missing-required-prop'
    | 'malformed-spec'
    | 'malformed-binding'
    | 'non-canonical-key'
    | 'gate-internal-error';
  readonly elementKey: string;
  readonly message: string;
};

// json-render dynamic pointer refs: { $state: '/ptr' } (read) and
// { $bindState: '/ptr' } (two-way write-back). Both are pointers into the
// bound state document, and one record may hold both. $item/$index/$cond are
// repeat/conditional-scoped markers the renderer resolves — the gate skips their
// values but keeps their keys.
function stateRefPointers(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null) return [];
  const v = value as Record<string, unknown>;
  return [v.$state, v.$bindState].filter(
    (pointer): pointer is string => typeof pointer === 'string',
  );
}

// Recursively collect every { $state } / { $bindState } pointer in a value.
// json-render's resolvePropValue recurses into plain objects and arrays, so
// nested refs are live grammar — walk them all.
function collectStateRefs(value: unknown, out: string[] = []): readonly string[] {
  const pointers = stateRefPointers(value);
  if (pointers.length > 0) {
    out.push(...pointers);
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

// True when a prop value carries a function-call operator or any unknown
// $-operator at ANY depth. Mirrors how the renderer resolves prop values: it
// recurses into conditional branches, plain objects, and arrays and CALLS the
// function a $computed names, so the gate fails closed on such an operator
// wherever it hides. A conditional resolves only its chosen branch (its condition
// uses the visibility grammar, which this gate does not validate), so only the branches
// are walked. A terminal marker normally holds a scalar the renderer reads directly;
// if its payload is instead a non-scalar (a mistyped marker), the renderer does not
// treat it as a marker and recurses into it, so the gate walks that payload too —
// only a scalar payload terminates safe, and the dead-code siblings of a scalar
// marker are not walked.
// Mirrors the pinned renderer's marker guards (@json-render/core resolvePropValue): a
// record is read as a single direct-value marker — its siblings never resolved — only
// when a string-payload marker matches or `$index === true`. Any other shape the renderer
// resolves as a generic object (every value walked), so the gate must walk it too. Keep
// this in lockstep with the renderer: a guard it type-checks that this omits reopens the
// nested-sibling smuggle path.
function isRendererDirectMarker(record: Record<string, unknown>): boolean {
  return (
    typeof record.$state === 'string' ||
    typeof record.$bindState === 'string' ||
    typeof record.$item === 'string' ||
    typeof record.$bindItem === 'string' ||
    typeof record.$template === 'string' ||
    record.$index === true
  );
}

// A conditional with both branches is read by the renderer as one value; an incomplete one is not.
const isCompleteCond = (record: Record<string, unknown>): boolean =>
  '$cond' in record && '$then' in record && '$else' in record;

// True when a value holds, at any depth, a record the renderer resolves as one value: a typed
// pointer, template or item marker, `$index` true, or a complete conditional. Such a value is only
// known at render time, so the checks made at generation leave it alone.
function containsMarker(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsMarker);
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isRendererDirectMarker(record) ||
    isCompleteCond(record) ||
    Object.values(record).some(containsMarker)
  );
}

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
  // A COMPLETE $cond ($cond + $then + $else all present) is a marker the renderer reads:
  // it resolves the chosen branch and never touches other siblings, so walk the two
  // branches only (the $cond condition uses the visibility grammar, which this gate
  // does not validate). An INCOMPLETE $cond is NOT a marker to the renderer — it resolves the
  // record as a generic object — so it must fall through to the walk-all below.
  if (isCompleteCond(record)) {
    return hasOffGrammarOperator(record.$then) || hasOffGrammarOperator(record.$else);
  }
  // A WELL-FORMED terminal marker (the renderer's OWN type guard: a string payload for
  // the pointer/template/item markers, or `$index === true`) is read directly and its
  // siblings are genuinely dead. A MISTYPED marker ($state:1, $index:'x', …) fails that
  // guard, so the renderer resolves the record as a generic object and walks every value
  // — a $computed nested in a sibling would execute — so it falls through to the walk-all.
  // ($path has no renderer handler at all, so it never terminates the walk.)
  if (isRendererDirectMarker(record)) return false;
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

// The ${/ptr} holes of a resourceTemplate whose pointer does not resolve to a string in the bound
// state. The holes are read from the catalog's own template, never from the text after substitution,
// so the work is bounded by the template and state text holding `${/` is never read as a hole.
function unresolvedPointers(template: string, state: JsonValue): readonly string[] {
  return holePointersOf(template).filter(
    (pointer) => typeof resolvePointer(state, pointer) !== 'string',
  );
}

// The state roots (first path segment) that the holes of a gated action's two templates read, once each.
function holeRoots(resourceTemplate: string, summaryTemplate: string): readonly string[] {
  const roots = new Set<string>();
  for (const pointer of [...holePointersOf(resourceTemplate), ...holePointersOf(summaryTemplate)]) {
    const root = pointer.split('/')[1];
    if (root !== undefined && root !== '') roots.add(root);
  }
  return [...roots];
}

// A param named by the first segment of a template hole must be bound to that state root, exactly
// { $state: '/<root>' }: the widget the user edited, the consent text and the run then read one value.
// An absent param is left to the params check (a required one is refused there; an optional one is
// supplied by the host from the same state).
function checkHoleBindings(
  actionName: string,
  catalog: MinituiCatalog,
  params: Readonly<Record<string, JsonValue>> | undefined,
  key: string,
): readonly SemanticIssue[] {
  const permission = catalog.permissionOf(actionName);
  const schema = catalog.actionDefs.get(actionName)?.params;
  if (permission === undefined || params === undefined || !(schema instanceof z.ZodObject))
    return [];
  const issues: SemanticIssue[] = [];
  for (const root of holeRoots(permission.resourceTemplate, permission.summaryTemplate)) {
    if (!Object.hasOwn(schema.shape, root) || !Object.hasOwn(params, root)) continue;
    const bound = params[root];
    const exact =
      typeof bound === 'object' &&
      bound !== null &&
      !Array.isArray(bound) &&
      Object.keys(bound).length === 1 &&
      Reflect.get(bound, '$state') === `/${root}`;
    if (!exact) {
      issues.push({
        code: 'bad-binding',
        elementKey: key,
        message: `Action param "${root}" for "${actionName}" on "${key}" must be bound to the state at "/${root}" (the action's templates read it).`,
      });
    }
  }
  return issues;
}

// The props that fail the component schema, named (empty when they pass). The names are the keys of
// an unknown-key issue, otherwise the first segment of each issue's path. For a Zod object,
// .partial() so omitted nullable keys don't false-positive (std defs require nullable keys
// present, specs omit them) while .strict()'s unknown-key rejection survives .partial() — an
// extra or mistyped prop still fails. Dynamic-marker values are blanked to undefined (the
// renderer resolves their runtime type) but their KEYS stay, so an UNKNOWN dynamic-valued key is
// still rejected. Non-object schemas fall back to a plain parse.
function failingProps(schema: ZodType, props: SpecElement['props']): readonly string[] {
  const result =
    schema instanceof z.ZodObject
      ? schema
          .partial()
          .safeParse(
            Object.fromEntries(
              Object.entries(props).map(([k, v]) => [k, containsMarker(v) ? undefined : v]),
            ),
          )
      : schema.safeParse(props);
  if (result.success) return [];
  const names = result.error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys' ? issue.keys : [String(issue.path[0] ?? 'props')],
  );
  return [...new Set(names)];
}

// The state pointers inside one named prop or param value. An empty pointer names the whole state
// document, which no prop or param may bind to; any other pointer must resolve against the state.
function checkPointers(
  value: unknown,
  surface: { readonly noun: 'Prop' | 'Action param'; readonly refusal: 'bad-props' | 'bad-params' },
  name: string,
  key: string,
  state: JsonValue,
): readonly SemanticIssue[] {
  return collectStateRefs(value).flatMap((pointer): readonly SemanticIssue[] => {
    if (pointer === '') {
      return [
        {
          code: surface.refusal,
          elementKey: key,
          message: `${surface.noun} "${name}" on "${key}" binds to the whole state document (an empty pointer) — name a path.`,
        },
      ];
    }
    if (resolvePointer(state, pointer) !== undefined) return [];
    return [
      {
        code: 'bad-binding',
        elementKey: key,
        message: `${surface.noun} binding "${pointer}" on "${key}" does not resolve against the bound state.`,
      },
    ];
  });
}

const PROP_SURFACE = { noun: 'Prop', refusal: 'bad-props' } as const;
const PARAM_SURFACE = { noun: 'Action param', refusal: 'bad-params' } as const;

// The size, padding, margin and gap props of the adopted components, and the largest number a spec
// may give one. The adopted schema bounds only a positive size, so a negative or huge value would
// reach the terminal layout engine unchecked.
const LAYOUT_BOUND = 1000;
const LAYOUT_PROPS: ReadonlySet<string> = new Set([
  'width',
  'height',
  'minWidth',
  'minHeight',
  'padding',
  'paddingX',
  'paddingY',
  'paddingTop',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
  'margin',
  'marginX',
  'marginY',
  'marginTop',
  'marginBottom',
  'marginLeft',
  'marginRight',
  'gap',
  'columnGap',
  'rowGap',
]);

function layoutIssues(el: SpecElement, key: string): readonly SemanticIssue[] {
  if (!Object.hasOwn(standardComponentDefinitions, el.type)) return [];
  return Object.entries(el.props)
    .filter(
      ([name, value]) =>
        LAYOUT_PROPS.has(name) && typeof value === 'number' && Math.abs(value) > LAYOUT_BOUND,
    )
    .map(([name]) => ({
      code: 'bad-props',
      elementKey: key,
      message: `Prop "${name}" on "${key}" is outside the layout bound of ${LAYOUT_BOUND}.`,
    }));
}

const quoted = (names: readonly string[]): string => names.map((name) => `"${name}"`).join(', ');

// The params of a binding checked against the action's schema, for what is known at generation.
// A value that holds a marker is only known at render time, so it counts as present and is not
// type-checked; every other value is parsed against the partial schema, and a key the schema
// requires must be an own key of the params. A schema that is not a plain object has no partial
// form and is left to the check at press time.
function checkParams(
  actionName: string,
  catalog: MinituiCatalog,
  params: Readonly<Record<string, JsonValue>> | undefined,
  key: string,
): readonly SemanticIssue[] {
  const schema = catalog.actionDefs.get(actionName)?.params;
  if (!(schema instanceof z.ZodObject)) return [];
  const given = params ?? {};
  const literal = Object.fromEntries(
    Object.entries(given).map(([k, v]) => [k, containsMarker(v) ? undefined : v]),
  );
  const failed = schema.partial().safeParse(literal);
  const named = failed.success
    ? []
    : failed.error.issues.map((issue) =>
        issue.code === 'unrecognized_keys'
          ? issue.keys.join(', ')
          : issue.path.map(String).join('.') || 'params',
      );
  for (const [paramKey, field] of Object.entries(schema.shape)) {
    if (isContentRequired(field) && !Object.hasOwn(given, paramKey)) named.push(paramKey);
  }
  return named.map((name) => ({
    code: 'bad-params',
    elementKey: key,
    message: `Action param "${name}" for "${actionName}" on "${key}" is missing or does not match the action's params.`,
  }));
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

  const unresolved =
    permission === undefined ? [] : unresolvedPointers(permission.resourceTemplate, state);
  if (permission !== undefined && unresolved.length > 0) {
    issues.push({
      code: 'bad-binding',
      elementKey: key,
      message: `resourceTemplate for "${actionName}" (${permission.resourceTemplate}) has a binding that does not resolve against the bound state: ${unresolved.join(', ')}.`,
    });
  }

  const unresolvedSummary =
    permission === undefined ? [] : unresolvedPointers(permission.summaryTemplate, state);
  if (permission !== undefined && unresolvedSummary.length > 0) {
    issues.push({
      code: 'bad-binding',
      elementKey: key,
      message: `summaryTemplate for "${actionName}" (${permission.summaryTemplate}) has a binding that does not resolve against the bound state: ${unresolvedSummary.join(', ')}.`,
    });
  }

  const status = catalog.actionDefs.get(actionName)?.statusPointers;
  if (status !== undefined) {
    const progress = resolvePointer(state, status.progress);
    if (typeof progress !== 'number' || !Number.isFinite(progress)) {
      issues.push({
        code: 'bad-binding',
        elementKey: key,
        message: `State for "${actionName}" must hold a number at "${status.progress}" (its progress, from 0 to 1): seed it.`,
      });
    }
    if (typeof resolvePointer(state, status.status) !== 'string') {
      issues.push({
        code: 'bad-binding',
        elementKey: key,
        message: `State for "${actionName}" must hold text at "${status.status}" (its outcome): seed it.`,
      });
    }
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
  return gatedIssues(spec, catalog, state).map(boundIssue);
}

function gatedIssues(
  spec: AppSpec,
  catalog: MinituiCatalog,
  state: JsonValue,
): readonly SemanticIssue[] {
  try {
    const screened = screenSpec(spec);
    if (screened.length > 0) {
      return screened.map(({ code, elementKey, message }) => ({ code, elementKey, message }));
    }
    return semanticIssues(spec, catalog, state);
  } catch {
    return [{ code: 'gate-internal-error', elementKey: '', message: GATE_INTERNAL_ERROR_MESSAGE }];
  }
}

// The semantic checks, run only on a spec the screen has passed.
function semanticIssues(
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
      const failing = failingProps(compDef.props, el.props);
      if (failing.length > 0) {
        issues.push({
          code: 'bad-props',
          elementKey: key,
          message: `Props for "${el.type}" failed the component schema (unknown or mistyped prop): ${quoted(failing)}.`,
        });
      }
      issues.push(...layoutIssues(el, key));
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
    for (const [propKey, value] of Object.entries(el.props)) {
      issues.push(...checkPointers(value, PROP_SURFACE, propKey, key, state));
    }

    for (const binding of collectBindings(el)) {
      // No-code moat: an action param feeds the renderer's resolveActionParam →
      // resolvePropValue at dispatch, which executes a $computed function — reject a
      // function-call or unknown expression operator in a param, fail closed.
      issues.push(...collectParamOffGrammar(binding.params ?? {}, key));

      // (2) dynamic action params: { $state } refs must resolve (the gate
      // inspects dynamic params, not just action names).
      for (const [paramKey, value] of Object.entries(binding.params ?? {})) {
        issues.push(...checkPointers(value, PARAM_SURFACE, paramKey, key, state));
      }

      for (const actionName of actionNamesOf(binding)) {
        issues.push(...checkAction(actionName, catalog, key, state));
        issues.push(...checkParams(actionName, catalog, binding.params, key));
        issues.push(...checkHoleBindings(actionName, catalog, binding.params, key));
      }
    }
  }
  return issues;
}
