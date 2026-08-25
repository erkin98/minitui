/**
 * @minitui/catalog — the trusted catalog contract + no-code allowlist.
 * Edges: catalog -> types, renderer-core, sanitizer (+ @json-render/core,
 * @json-render/ink/server, zod). Never the React @json-render/ink root entry.
 */

// contract
export type { MinituiActionDef } from './contract/catalog-action.js';
export { defineAction, requiresPermission } from './contract/catalog-action.js';
export type { MinituiComponentDef, TrustTier } from './contract/catalog-component.js';
export { defineComponent } from './contract/catalog-component.js';
export type { ActionKind, PermissionDescriptor } from './contract/action-kind.js';
export { applyResourceTemplate, resolvePointer } from './contract/action-kind.js';
export type { VisibilityClass } from './contract/visibility.js';
export { isWiderThan, DEFAULT_VISIBILITY, SECRET_VISIBILITY } from './contract/visibility.js';
export type { ActionBinding, AppSpec, SpecElement } from './contract/spec.js';

// schema bridge (React-free std defs)
export {
  standardComponentDefinitions,
  standardActionDefinitions,
  STD_ACTION_NAMES,
  type ComponentDefinition,
  type ActionDefinition,
} from './schema-bridge.js';

// builders
export { defineMinituiCatalog, type MinituiCatalog } from './define-catalog.js';

// allowlist (the two-point gate)
export { rejectOffCatalog, throwingFallback, type AllowlistIssue } from './allowlist.js';

// validate
export { checkSemantics, type SemanticIssue } from './validate/semantic.js';
export { CATALOG_REPAIR_WORDING } from './validate/runtime.js';
export {
  runFullValidation,
  type ValidationIssue,
  type ValidationResult,
} from './validate/index.js';

// prompt
export { buildCatalogPrompt } from './prompt.js';

// sanitize (bind-time entry)
export { sanitize, sanitizeSpecStrings } from './sanitize/index.js';

// catalogs
export { videoMergeCatalog } from './catalogs/index.js';
