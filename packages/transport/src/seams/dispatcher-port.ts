import type { JsonValue } from '../state/json-pointer.js';

/**
 * Contract only — the host runs the permission gate behind this; transport never does.
 * Shape-matches renderer-core's ActionDispatcher without importing it. Transport depends only on
 * types and sanitizer; renderer-core is deliberately outside its allowed dependency set.
 */
export interface ActionDispatcherPort {
  dispatch(
    actionName: string,
    ctx: {
      readonly resolvedParams: Record<string, unknown>;
      readonly stateSnapshot: JsonValue;
      readonly elementKey: string;
    },
  ): Promise<{ status: 'settled' | 'denied' | 'failed' | 'awaiting'; detail?: unknown }>;
}
