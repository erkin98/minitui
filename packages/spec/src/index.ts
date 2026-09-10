/**
 * @minitui/spec — the MiniAppSpec contract + the validate/autoFix/reprompt loop.
 * The curated public barrel: every symbol siblings consume, re-exported from its
 * owning module. @minitui/types keeps the wire vocabulary (AppSpec/SpecElement);
 * this package hands off the branded MiniAppSpec and bridges to the wire shape
 * once via toWireSpec.
 */

// Spec types: json-render structural shapes + the spec-owned handoff brand
// (AppSpec/SpecElement stay with their owner @minitui/types)
export type { Spec, UIElement, DynamicValue, MiniAppSpec, SpecMeta } from './spec-types.js';
export { createSpecStreamCompiler, compileSpecStream } from './stream-compile.js';

// Canonical action-kind discriminant (kebab-case, re-exported from @minitui/types)
export { ACTION_KINDS, ActionKindSchema, type ActionKind } from './catalog-action.js';

// Pointer helpers
export { getByPath, collectBoundPointers, type BoundPointer } from './pointer.js';

// Structural (adopted wrappers)
export {
  validateStructure,
  autoFixStructure,
  formatStructuralIssues,
  MAX_RETRIES,
  type SpecIssue,
} from './structural.js';

// Capability port
export type { CapabilityProvider, FileStat } from './capability-port.js';

// Semantic
export {
  type SemanticIssue,
  type SemanticResult,
  type SemanticCode,
} from './semantic/semantic-types.js';
export { resolveBindings } from './semantic/resolve-bindings.js';
export { checkCapabilities } from './semantic/check-capabilities.js';
export { checkFiles } from './semantic/check-files.js';
export { checkVisibility } from './semantic/check-visibility.js';
export { validateSemantics } from './semantic/semantic-validator.js';

// Runtime correction
export { type RuntimeError } from './runtime/runtime-error.js';
export { toRuntimeRepair, type RuntimeRepair } from './runtime/runtime-correction.js';

// Envelope + loop (the deliverables)
export { type ValidationEnvelope, buildValidationEnvelope, toRepromptText } from './envelope.js';
export { composeValidation, toWireSpec } from './loop.js';
export {
  REPAIR_HEADER,
  SEMANTIC_HEADER,
  CATALOG_HEADER,
  formatSemanticIssues,
  formatCatalogIssues,
} from './prompt-fragments.js';
