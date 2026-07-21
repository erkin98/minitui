import type { JsonValue } from './json-pointer.js';

export interface StorePort {
  getState(): JsonValue;
  getIn(pointer: string): JsonValue | undefined;
  subscribe(fn: (state: JsonValue) => void): () => void;
}
