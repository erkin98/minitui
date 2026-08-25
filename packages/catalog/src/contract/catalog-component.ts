import type { ComponentDefinition } from '../schema-bridge.js';
import type { WidgetCatalogBinding } from '@minitui/renderer-core';
import type { VisibilityClass } from './visibility.js';

// Trust ladder: display widgets are inert, interactive widgets fire actions.
// DERIVED from renderer-core's WidgetCatalogBinding so the catalog and renderer
// share ONE closed union (no drift-prone duplicate) — the catalog declares the
// tier, renderer-ink's bindings resolve against it. This is the one src use of the
// allowed catalog -> renderer-core edge (import-type only, erased at build — no
// runtime edge). WidgetCatalogBinding's default `<W = unknown>` lets the bare
// `['resolve']` derivation resolve the tier.
export type TrustTier = NonNullable<ReturnType<WidgetCatalogBinding['resolve']>>['trustTier'];

/**
 * A json-render ComponentDefinition ({ props, slots, events?, description }) plus
 * the trust tier. `slots` is REQUIRED by this contract (defineCatalog itself never
 * validates it) — declare ['default'] for a child container, [] for a leaf. Build
 * the props zod with .strict() per component so unknown props surface as a semantic
 * issue (the lenient core validator skips per-component props).
 *
 * `visibility` is the builder-owned field-visibility class — the agent cannot widen
 * it; omitted defaults to DEFAULT_VISIBILITY ('clientOnly'). `secret: true` marks a
 * password/token field and forces `localOnly`: the catalog builder rejects a secret
 * component declared any wider, fail closed.
 *
 * `capturesText` marks a FREE-TEXT-capturing widget — one whose focused handler
 * consumes typed characters (a TextInput-style field). The app-shell quit predicate
 * keeps `q` as literal input while such a widget is focused (and lets `q` quit
 * otherwise), so the binding surfaces it: WidgetCatalogBinding.resolve() returns
 * { factory, trustTier, capturesText } and the q-predicate reads it. Omitted
 * defaults to false (a non-text widget — `q` quits).
 */
export interface MinituiComponentDef extends ComponentDefinition {
  readonly trustTier: TrustTier;
  readonly visibility?: VisibilityClass;
  readonly secret?: boolean;
  readonly capturesText?: boolean;
}

// Identity helper — applies the MinituiComponentDef contract type at the definition
// site, so a def that misses the contract is a compile error where it is written.
export function defineComponent(def: MinituiComponentDef): MinituiComponentDef {
  return def;
}
