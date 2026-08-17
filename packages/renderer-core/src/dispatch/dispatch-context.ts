import type { ActionKind, PermissionDescriptor, JsonValue, ExecEvent } from '@minitui/types';

/**
 * The context one dispatch carries through the moat seam.
 *
 * `resolvedParams` are RESOLVED against the live state snapshot — concrete values,
 * NEVER the agent's `${/pointer}` template. The permission gate and the consent
 * overlay both read these resolved values, so the user always approves what will
 * actually run (security invariant: consent shows HOST-resolved values, not agent text).
 */
export interface DispatchContext {
  /** the catalog action name being invoked. */
  readonly actionName: string;
  /** routes the dispatch: render-local stays local, the other three gate first. */
  readonly actionKind: ActionKind;
  /** present for every non-render-local action; absent for render-local. */
  readonly permission?: PermissionDescriptor | undefined;
  /** RESOLVED params — concrete values bound from state, never the agent template. */
  readonly resolvedParams: Record<string, unknown>;
  /** immutable snapshot of the local data model at dispatch time. */
  readonly stateSnapshot: JsonValue;
  /** provenance: the spec element key that triggered the action. */
  readonly elementKey: string;
  /**
   * The exec-progress→store correlation seam. Optional per-dispatch callback the
   * dispatcher streams `ExecEvent`s through, so the composition root can map
   * `{ kind: 'progress', value }` into a state delta and the UI updates live. Additive —
   * does NOT touch the swap surface (`RendererPort`/`WidgetCatalogBinding`); a dispatcher
   * that ignores progress simply omits it.
   */
  onEvent?(ev: ExecEvent): void;
}
