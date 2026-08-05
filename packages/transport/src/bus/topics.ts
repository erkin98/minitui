import { createReadonlySet } from '../collections/readonly-set.js';

export type Topic =
  | 'token'
  | 'content'
  | 'visibility'
  | 'state-delta'
  | 'state-snapshot'
  | 'run-status'
  | 'error'
  | 'action';

export interface TopicPayloads {
  token: string;
  content: string;
  visibility: { note: string };
  'state-delta': { delta: unknown };
  'state-snapshot': { snapshot: unknown };
  'run-status': { phase: 'started' | 'finished' };
  error: { message: string; retriable: boolean };
  action: { toolCallId: string };
}

/** Only these collapse same-topic bursts. STATE_DELTA is deliberately excluded. */
export const COALESCIBLE: ReadonlySet<Topic> = createReadonlySet([
  'token',
  'content',
  'visibility',
]);

/**
 * Topics whose payloads apply positionally against one evolving document (RFC-6902 deltas, in
 * `state-delta`'s case). Losing any queued item — not just the oldest — corrupts every later
 * apply, so a queue backing one of these topics must never silently evict; construct its
 * `BoundedQueue` with `lossy: false`. Contrast `COALESCIBLE`: those payloads supersede one
 * another, so dropping a stale one is safe.
 */
export const POSITIONAL: ReadonlySet<Topic> = createReadonlySet(['state-delta']);
