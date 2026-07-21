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
export const COALESCIBLE: ReadonlySet<Topic> = new Set<Topic>(['token', 'content', 'visibility']);
