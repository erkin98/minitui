import type { ZodType } from 'zod';
import type { ActionKind, PermissionDescriptor } from './action-kind.js';
import type { VisibilityClass } from './visibility.js';

/**
 * A json-render ActionDefinition ({ params, description }) extended with the
 * minitui-owned ActionKind + PermissionDescriptor — the superset json-render is
 * unaware of. params is enforced at the dispatch boundary (renderer-ink's
 * gated-handler safeParses the resolved params before the gate).
 * `callableFrom` is the builder-owned action-boundary visibility class — the
 * agent cannot widen it; omitted ⇒ DEFAULT_VISIBILITY ('clientOnly').
 */
export interface MinituiActionDef<P = unknown> {
  readonly params: ZodType<P>;
  readonly description: string;
  readonly kind: ActionKind;
  readonly permission?: PermissionDescriptor | undefined;
  readonly callableFrom?: VisibilityClass;
}

// Identity helper pinning the literal type at the definition site.
export function defineAction<P>(def: MinituiActionDef<P>): MinituiActionDef<P> {
  return def;
}

// Every kind except render-local must carry a PermissionDescriptor.
export function requiresPermission(kind: ActionKind): boolean {
  return kind !== 'render-local';
}
