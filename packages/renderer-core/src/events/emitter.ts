import type { ActionLifecycleEvent } from './lifecycle.js';

/**
 * Sink for lifecycle events. Transport-agnostic: the cli wires a concrete
 * emitter that forwards to the AG-UI stream; tests wire an array collector.
 */
export interface LifecycleEmitter {
  emit(event: ActionLifecycleEvent): void;
}
