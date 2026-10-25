import type { AppSpec, JsonValue, JsonPatch, ActionRequest } from '@minitui/types';
import type { WidgetCatalogBinding } from './widget-binding.js';
import type { ActionDispatcher } from './dispatch/action-dispatcher.js';
import type { LifecycleEmitter } from './events/emitter.js';

/**
 * Why a renderer refuses to mount or update. A renderer refuses by throwing an Error whose `code` is
 * a member, before any render, at mount and at update. The host treats the first two codes as
 * builder errors and rethrows them; the other four go to the repair path.
 */
export type RendererRefusalCode =
  | 'unbound-component'
  | 'initial-state-unsupported'
  | 'not-a-tree'
  | 'non-canonical-key'
  | 'watch-unsupported'
  | 'off-catalog';

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
    /**
     * The state the app starts with. An implementation whose state lives in an external store refuses a
     * defined `initialState` with the code `initial-state-unsupported`.
     */
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
