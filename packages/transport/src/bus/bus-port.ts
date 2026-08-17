import type { Topic, TopicPayloads } from './topics.js';

// Distribute the publish argument tuple over Topic so each (topic, payload) pair stays correlated
// even when the caller holds the topic in a widened `Topic` variable. A generic `<T extends
// Topic>(topic: T, payload: TopicPayloads[T])` infers `T = Topic` for a widened topic, collapsing
// `payload` to the union of every payload type (which includes `string`) — so a raw string slipped
// through for 'error'. A union of correlated tuples has no such collapse: `[Topic, string]` matches
// no member. `subscribe` stays generic: the same widening forces the listener to accept the payload
// UNION (contravariance), which is already type-safe at runtime, and the tuple form would break the
// contextual typing of every `(p) => …` callback.
export type PublishArgs = { [K in Topic]: [topic: K, payload: TopicPayloads[K]] }[Topic];

export interface BusPort {
  publish(...args: PublishArgs): void;
  // TypeScript's void callback rule accepts async implementations while preserving
  // concise callbacks whose incidental return value is intentionally ignored.
  // Per-subscriber delivery is capacity-bounded. A topic in `topics.ts`'s `COALESCIBLE` set may
  // collapse a burst to its latest value; every other topic must deliver every published item —
  // in particular a topic in `POSITIONAL` (positional patches applying against one evolving
  // document) may never silently evict a queued item once capacity is reached.
  subscribe<T extends Topic>(topic: T, fn: (p: TopicPayloads[T]) => void): () => void;
}
