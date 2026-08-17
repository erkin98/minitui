import type { JsonValue } from './json-pointer.js';

export type StoreSubscriber = (state: JsonValue) => void | Promise<void>;

export interface StorePort {
  getState(): JsonValue;
  getIn(pointer: string): JsonValue | undefined;
  subscribe(fn: StoreSubscriber): () => void;
}
