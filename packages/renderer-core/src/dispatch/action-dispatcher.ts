import type { DispatchContext } from './dispatch-context.js';
import type { ActionOutcome } from './outcome.js';

/**
 * ActionKind is owned by @minitui/types; re-export it here so downstream
 * renderers import the kind alongside the dispatcher from one seam, never
 * redefining it (single source of truth stays in types).
 */
export type { ActionKind } from '@minitui/types';

/**
 * The moat seam. Every UI action routes through one `dispatch`. The implementation
 * (wired in apps/cli/src/main.tsx over @minitui/exec) gates everything whose
 * `actionKind` is not 'render-local' through the permission engine BEFORE any side
 * effect. The renderer only ever calls this — it never sees an executor port.
 */
export interface ActionDispatcher {
  dispatch(actionName: string, ctx: DispatchContext): Promise<ActionOutcome>;
}
