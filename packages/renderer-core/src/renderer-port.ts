import type { AppSpec, JsonValue, JsonPatch, ActionRequest } from '@minitui/types';
import type { WidgetCatalogBinding } from './widget-binding.js';
import type { ActionDispatcher } from './dispatch/action-dispatcher.js';
import type { LifecycleEmitter } from './events/emitter.js';

/**
 * THE swap boundary. No React or Ink appears in any signature — renderer-ink is
 * the only package that knows the concrete on the other side. Migrating to OpenTUI
 * is adding one package and editing one line of apps/cli/src/main.tsx.
 */
export interface RendererPort {
  mount(args: {
    spec: AppSpec;
    binding: WidgetCatalogBinding;
    dispatcher: ActionDispatcher;
    initialState?: JsonValue | undefined;
    onLifecycle?: LifecycleEmitter | undefined;
    accessible?: boolean | undefined;
    onQuit?: (() => void) | undefined; // app-shell `q` → host maps to requestQuit({completed,0})
    onCancel?: (() => void) | undefined; // app-shell Esc → host maps to requestQuit({cancelled,130})
  }): Promise<RenderHandle>;
}

/**
 * The live handle to a mounted app.
 */
export interface RenderHandle {
  /** swap in a new spec; the IMPL re-sanitizes its strings (same chokepoint as mount). */
  update(spec: AppSpec): void;
  /** apply an RFC-6902 patch batch; re-renders only touched subtrees. */
  applyStatePatch(patch: readonly JsonPatch[]): void;
  /** subscribe to actions a widget raises; returns an unsubscribe fn. */
  onAction(handler: (req: ActionRequest) => void): () => void;
  /** tear down and restore the terminal. */
  unmount(): void;
}
