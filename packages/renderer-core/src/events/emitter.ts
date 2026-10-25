import type { ActionLifecycleEvent } from './lifecycle.js';

/**
 * Sink for lifecycle events. Transport-agnostic: the host supplies the sink;
 * tests wire an array collector.
 */
export interface LifecycleEmitter {
  emit(event: ActionLifecycleEvent): void;
}
