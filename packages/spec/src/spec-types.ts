import type { Spec, UIElement, DynamicValue } from '@json-render/core';

// Re-export json-render's STRUCTURAL working shapes verbatim. These are what the
// adopted validators (validateSpec/autoFixSpec), the stream compiler, the binding
// walker, and (downstream) the renderer operate on — they carry $state bindings,
// on/watch ActionBindings, repeat, visible.
export type { Spec, UIElement, DynamicValue };

/** Provenance + versioning carried alongside a validated spec. */
export interface SpecMeta {
  /** Which catalog produced/validated this spec. */
  readonly catalogId: string;
  /** Integer schema version for the kept-app migration loader. */
  readonly schemaVersion: number;
  /** The original user prompt, if recorded (kept apps carry it). */
  readonly sourcePrompt?: string;
}

/**
 * The validated handoff every sibling consumes (runtime-host, renderer-ink,
 * library). OWNED here: it brands json-render's
 * `Spec` — NOT `@minitui/types` `AppSpec` — so the `on`/`watch` action bindings
 * the renderer dispatches survive the handoff unmapped, with `state`
 * narrowed to a guaranteed object plus optional provenance meta. `@minitui/types`
 * owns the wire vocabulary `AppSpec`/`SpecElement` (the field-for-field mirror
 * the catalog gate types against); the loop produces THIS type once the
 * structural + catalog + semantic gates pass.
 */
export type MiniAppSpec = Spec & {
  state: Record<string, unknown>;
  meta?: SpecMeta;
};
