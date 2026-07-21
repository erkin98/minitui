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

/**
 * Only these collapse same-topic bursts. STATE_DELTA is deliberately excluded — coalescing deltas
 * would drop intermediate RFC-6902 patches and corrupt state. The `ReadonlySet` type is compile-time
 * only, so the mutators are sealed off: a runtime cast-escape must not be able to add 'state-delta'
 * (or drop an entry) after the fact. `has`, `size`, and iteration keep working from the prototype.
 */
const coalescible = new Set<Topic>(['token', 'content', 'visibility']);
const sealMutator = (): never => {
  throw new TypeError('COALESCIBLE is immutable');
};
for (const method of ['add', 'delete', 'clear'] as const) {
  // Non-writable, non-configurable own props shadow the prototype mutators (Object.freeze on a Set
  // does not stop .add() — it only affects own properties, and the mutators live on the prototype).
  Object.defineProperty(coalescible, method, { value: sealMutator });
}
export const COALESCIBLE: ReadonlySet<Topic> = coalescible;
