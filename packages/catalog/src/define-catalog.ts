import { z, type ZodType } from 'zod';
import { defineCatalog, type PromptOptions } from '@json-render/core';
import { inkSchema, type ComponentDefinition, type ActionDefinition } from './schema-bridge.js';
import type { MinituiComponentDef, TrustTier } from './contract/catalog-component.js';
import { requiresPermission, type MinituiActionDef } from './contract/catalog-action.js';
import type { ActionKind, PermissionDescriptor } from './contract/action-kind.js';
import {
  DEFAULT_VISIBILITY,
  SECRET_VISIBILITY,
  type VisibilityClass,
} from './contract/visibility.js';

// The adopted-catalog surface minitui consumes. `defineCatalog` is generic, so
// `ReturnType<typeof defineCatalog>` collapses its unresolved type parameters to
// `any` — which then infects every `catalog.base.*` read downstream. The package
// only ever calls `.prompt()` on the adopted catalog (the allowlist/validation is
// re-implemented here, never delegated to `base`), so pin exactly that method; the
// concrete `defineCatalog(...)` result is structurally assignable to it.
interface JsonRenderCatalog {
  prompt(options?: PromptOptions): string;
}

const ACTION_KINDS: ReadonlySet<string> = new Set([
  'render-local',
  'exec-local',
  'exec-mcp',
  'agent-callback',
]);

// An OPEN top-level schema (z.record, or an object with a passthrough/catchall
// escape hatch) is an arbitrary-data hole behind the .strict() surface — reject at
// build time, fail closed. Top-level only: nested z.unknown() leaves (e.g.
// setState's `value`) stay legal.
function assertClosedSchema(context: string, schema: ZodType): void {
  if (schema instanceof z.ZodRecord) {
    throw new Error(
      `${context}: a top-level z.record schema defeats the allowlist — declare explicit keys.`,
    );
  }
  if (schema instanceof z.ZodObject) {
    const catchall = schema.def.catchall;
    if (catchall !== undefined && !(catchall instanceof z.ZodNever)) {
      throw new Error(
        `${context}: a passthrough/catchall schema defeats the allowlist — use .strict().`,
      );
    }
  }
}

// Fail-closed action ingest: an unrecognized kind or a gate-less non-render-local
// action is a catalog-definition error, never a permissive default.
function assertActionDef(name: string, def: MinituiActionDef): void {
  if (!ACTION_KINDS.has(def.kind)) {
    throw new Error(
      `Catalog action "${name}": unknown kind "${String(def.kind)}" — fail closed, no permissive default.`,
    );
  }
  if (requiresPermission(def.kind) && def.permission === undefined) {
    throw new Error(
      `Catalog action "${name}": kind "${def.kind}" requires a PermissionDescriptor.`,
    );
  }
}

export interface MinituiCatalog {
  readonly id: string;
  readonly base: JsonRenderCatalog;
  readonly componentNames: readonly string[];
  readonly actionNames: readonly string[];
  readonly tierOf: (component: string) => TrustTier | undefined;
  readonly kindOf: (action: string) => ActionKind | undefined;
  readonly permissionOf: (action: string) => PermissionDescriptor | undefined;
  readonly visibilityOf: (component: string) => VisibilityClass | undefined;
  readonly callableFromOf: (action: string) => VisibilityClass | undefined;
  readonly componentDefs: ReadonlyMap<string, MinituiComponentDef>;
  readonly actionDefs: ReadonlyMap<string, MinituiActionDef>;
}

// Strip the minitui-only fields json-render is unaware of before handing the defs
// to the adopted defineCatalog — it only knows { props, slots, events?, description }
// / { params, description }. The required `slots` field rides through to defineCatalog.
function toBaseComponent(def: MinituiComponentDef): ComponentDefinition {
  const {
    trustTier: _tier,
    visibility: _visibility,
    secret: _secret,
    capturesText: _capturesText,
    ...base
  } = def;
  return base;
}
function toBaseAction(def: MinituiActionDef): ActionDefinition {
  const { kind: _kind, permission: _permission, callableFrom: _callableFrom, ...base } = def;
  return base;
}

// The adopted std defs (Box/Select/ProgressBar/Text) are plain STRIPPING z.object —
// .partial().safeParse silently DROPS an unknown key, so the per-element prop check
// would pass an off-catalog static prop AND it would survive into the rendered spec.
// Normalize every plain ZodObject props schema to .strict() for the componentDefs map
// the prop gate reads, so unknown keys are rejected for std defs exactly as for the
// custom .strict() defs. assertClosedSchema already rejected record/passthrough/catchall
// above, so this only tightens plain objects; .strict() on an already-strict schema is
// idempotent. Immutable (new def).
function strictenComponentProps(def: MinituiComponentDef): MinituiComponentDef {
  return def.props instanceof z.ZodObject ? { ...def, props: def.props.strict() } : def;
}

// Fail-closed: a secret-typed component may not be declared any WIDER than localOnly
// (never projected to the model, never a remote callback param). Reject rather than
// silently coerce.
function assertSecretVisibility(name: string, def: MinituiComponentDef): void {
  if (def.secret && def.visibility !== undefined && def.visibility !== SECRET_VISIBILITY) {
    throw new Error(
      `Catalog component "${name}": a secret-typed component is forced ${SECRET_VISIBILITY}; ` +
        `remove the wider visibility "${def.visibility}".`,
    );
  }
}

export function defineMinituiCatalog(args: {
  id: string;
  components: Record<string, MinituiComponentDef>;
  actions: Record<string, MinituiActionDef>;
}): MinituiCatalog {
  const baseComponents: Record<string, ComponentDefinition> = {};
  const baseActions: Record<string, ActionDefinition> = {};
  const componentDefs = new Map<string, MinituiComponentDef>();
  const actionDefs = new Map<string, MinituiActionDef>();

  for (const [name, def] of Object.entries(args.components)) {
    assertSecretVisibility(name, def);
    assertClosedSchema(`Catalog component "${name}" props`, def.props);
    baseComponents[name] = toBaseComponent(def);
    // Store the .strict()-normalized def so the prop gate rejects unknown keys on
    // plain std defs (the base handed to defineCatalog stays as-authored — defineCatalog
    // collapses per-component props to z.record anyway).
    componentDefs.set(name, strictenComponentProps(def));
  }
  for (const [name, def] of Object.entries(args.actions)) {
    assertActionDef(name, def);
    assertClosedSchema(`Catalog action "${name}" params`, def.params);
    baseActions[name] = toBaseAction(def);
    actionDefs.set(name, def);
  }

  // ADOPT: the single-source catalog — prompt()/validate()/zodSchema() all derive from
  // this one definition. componentNames/actionNames are read off the input Record keys
  // (the same source defineCatalog receives) so the moat index can never drift from what
  // defineCatalog allowlisted.
  const base = defineCatalog(inkSchema, {
    components: baseComponents,
    actions: baseActions,
  });

  return {
    id: args.id,
    base,
    componentNames: Object.keys(args.components),
    actionNames: Object.keys(args.actions),
    tierOf: (c) => componentDefs.get(c)?.trustTier,
    kindOf: (a) => actionDefs.get(a)?.kind,
    permissionOf: (a) => actionDefs.get(a)?.permission,
    // Resolved builder-owned visibility ceiling (declared ?? secret→localOnly ??
    // default); undefined for an unregistered name. The downstream widen-check compares
    // an agent-requested class against this.
    visibilityOf: (c) => {
      const def = componentDefs.get(c);
      if (def === undefined) return undefined;
      return def.secret ? SECRET_VISIBILITY : (def.visibility ?? DEFAULT_VISIBILITY);
    },
    callableFromOf: (a) => {
      const def = actionDefs.get(a);
      if (def === undefined) return undefined;
      return def.callableFrom ?? DEFAULT_VISIBILITY;
    },
    componentDefs,
    actionDefs,
  };
}
