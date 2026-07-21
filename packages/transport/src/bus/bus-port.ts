import type { Topic, TopicPayloads } from './topics.js';

export interface BusPort {
  publish<T extends Topic>(topic: T, payload: TopicPayloads[T]): void;
  subscribe<T extends Topic>(topic: T, fn: (p: TopicPayloads[T]) => void): () => void;
}
