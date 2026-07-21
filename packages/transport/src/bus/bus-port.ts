import type { Topic, TopicPayloads } from './topics.js';

// Distribute the publish argument tuple over Topic so each (topic, payload) pair stays correlated
// even when the caller holds the topic in a widened `Topic` variable. A generic `<T extends
// Topic>(topic: T, payload: TopicPayloads[T])` infers `T = Topic` for a widened topic, collapsing
// `payload` to the union of every payload type (which includes `string`) — so a raw string slipped
// through for 'error'. A union of correlated tuples has no such collapse: `[Topic, string]` matches
// no member. `subscribe` stays generic: the same widening forces the listener to accept the payload
// UNION (contravariance), which is already type-safe at runtime, and the tuple form would break the
// contextual typing of every `(p) => …` callback.
type PublishArgs = { [K in Topic]: [topic: K, payload: TopicPayloads[K]] }[Topic];

export interface BusPort {
  publish(...args: PublishArgs): void;
  subscribe<T extends Topic>(topic: T, fn: (p: TopicPayloads[T]) => void): () => void;
}
