import type { JsonValue } from '../state/json-pointer.js';
import type { JsonPatchOp } from '../state/patch-apply.js';
import type { AppEvent } from '../events/app-event.js';

/** Read-only feed a renderer subscribes to — the swap boundary's transport side. */
export interface RendererFeedPort {
  onEvent(fn: (e: AppEvent) => void): () => void;
  onStatePatch(fn: (patch: readonly JsonPatchOp[]) => void): () => void;
  getState(): JsonValue;
}
