// Curated named barrel — the @minitui/types public surface.
//
// ActionKind / ActionKindSchema are declared in catalog.ts and re-exported by
// actions.ts for ergonomic single-module import. `export *` from BOTH would make
// TypeScript SILENTLY OMIT the colliding name from this barrel (it does NOT raise
// TS2308 for `export *` ambiguity — it just drops it), so we re-export ActionKind
// EXPLICITLY from its canonical owner first, then `export *` everything else. The
// explicit local re-export wins over the ambiguous star, keeping the symbol on the
// barrel deterministically. Split type/value because verbatimModuleSyntax (NodeNext
// strict) forbids re-exporting a type without the `type` modifier.
export { ActionKindSchema } from './catalog.js';
export type { ActionKind } from './catalog.js';

export * from './pointer.js';
export * from './catalog.js';
export * from './actions.js';
export * from './spec.js';
export * from './events.js';
export * from './permission.js';
export * from './library.js';
export * from './ports.js';
export * from './diagnostics.js';
