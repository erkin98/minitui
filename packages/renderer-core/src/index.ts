/**
 * @minitui/renderer-core — the renderer swap boundary.
 * Pure interfaces, zero runtime. The only allowed dependency is @minitui/types.
 */
export type { RendererPort, RenderHandle } from './renderer-port.js';
export type { WidgetCatalogBinding } from './widget-binding.js';
export type { ActionDispatcher, ActionKind } from './dispatch/action-dispatcher.js';
export type { DispatchContext } from './dispatch/dispatch-context.js';
export type { ActionOutcome } from './dispatch/outcome.js';
export type { ActionLifecycleEvent } from './events/lifecycle.js';
export type { LifecycleEmitter } from './events/emitter.js';
