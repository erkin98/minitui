import type { RuntimeFault } from '@minitui/types';

/**
 * The settled result of dispatching one action through the moat seam.
 *  - settled:  ran to completion (result optional — render-local mutations carry none).
 *  - denied:   the permission gate refused; `reason` is the HOST-resolved denial text.
 *  - failed:   ran but faulted; `fault` is the sanitized RuntimeFault for self-correction.
 *  - awaiting: returned by no shipped dispatcher (the permission check blocks until the user
 *              answers); kept for a dispatcher that returns before the answer.
 */
export type ActionOutcome =
  | { status: 'settled'; result?: unknown }
  | { status: 'denied'; reason: string }
  | { status: 'failed'; fault: RuntimeFault }
  | { status: 'awaiting'; requestId: string };
