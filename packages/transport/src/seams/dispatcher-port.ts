import type { JsonValue } from '../state/json-pointer.js';

/**
 * Contract only — the host runs the permission gate behind this; transport never does.
 * Shape-matches renderer-core's ActionDispatcher without importing it (transport is a leaf).
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
