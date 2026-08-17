import type { RuntimeFault } from '@minitui/types';

/**
 * The transport-agnostic lifecycle of one dispatched action.
 * agent-core bridges these to AG-UI ACTIVITY_* / RUN_ERROR events at the
 * composition root; renderer-core owns only the shape.
 * `awaiting` is the first-class consent-pending phase (the ACP
 * tool-call pending state): a blocking `engine.check` surfaces it with the
 * `requestId` rather than smuggling the ask through a fake `progress`.
 */
export type ActionLifecycleEvent =
  | { phase: 'started'; actionName: string; elementKey: string }
  | { phase: 'awaiting'; actionName: string; elementKey: string; requestId: string }
  | {
      phase: 'progress';
      actionName: string;
      elementKey: string;
      progress: number;
      message?: string;
    }
  | { phase: 'result'; actionName: string; elementKey: string; result?: unknown }
  | { phase: 'error'; actionName: string; elementKey: string; fault: RuntimeFault };
