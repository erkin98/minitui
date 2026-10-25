import type { RuntimeFault } from '@minitui/types';

/**
 * The transport-agnostic lifecycle of one dispatched action; renderer-core owns only the shape.
 * `awaiting` is the consent-pending phase. No shipped dispatcher produces it: the permission check
 * blocks until the user answers, so a dispatch settles, is denied or fails. The member stays for a
 * dispatcher that returns before the answer.
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
