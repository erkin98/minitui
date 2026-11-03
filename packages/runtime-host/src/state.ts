import { foldDelta, type DataStore, type JsonPatchOp } from '@minitui/transport';
import { JsonObjectSchema, type JsonValue } from '@minitui/types';

/**
 * The host's view over the one shared data store: the same instance the renderer's state adapter wraps,
 * created once by the composition root. The host never builds a second store and never re-implements
 * patch application, so there is one document and one notification channel.
 *
 * The three render-local writes follow json-render's own built-in actions: set a pointer, append to
 * the array at a pointer, remove an array member by index.
 */
export interface HostState {
  getState(): JsonValue;
  getIn(pointer: string): JsonValue | undefined;
  subscribe(fn: (state: JsonValue) => void): () => void;
  /** Replaces the whole model from a validated spec.state; the store strips terminal control text. */
  seed(model: unknown): void;
  /** Applies an RFC 6902 batch; a batch that would leave a non-object root throws and changes nothing. */
  applyStatePatch(patch: readonly JsonPatchOp[]): void;
  setState(pointer: string, value: JsonValue): void;
  /** Appends to the array at a pointer; a value that is not an array is replaced by a one-element array. */
  pushState(pointer: string, value: JsonValue): void;
  /** Removes one member of the array at a pointer; anything that is not an array member is a no-op. */
  removeState(pointer: string, index: number): void;
}

/**
 * Reads see the committed document, but every write builds on the document as it will be once the writes
 * queued behind the current notification are committed. A render-local action fired from a store
 * subscriber therefore must write with operations that fold against that staged document: a read of the
 * array followed by a write of a whole new array would drop an earlier staged write.
 */
export function createHostState(store: DataStore): HostState {
  return {
    getState: () => store.getState(),
    getIn: (pointer) => store.getIn(pointer),
    subscribe: (fn) => store.subscribe(fn),
    seed: (model) => store.applySnapshot(JsonObjectSchema.parse(model)),
    applyStatePatch: (patch) => {
      // Moving or copying onto the root takes its result from the document the patch meets. The check below
      // reads the committed document, so from inside a notification it could pass a patch that, against the
      // staged document, leaves a number or a list as the whole state. The other operations on the root
      // (add, replace, remove) do not depend on the document, so the check is exact for them.
      for (const op of patch) {
        if ((op.op === 'move' || op.op === 'copy') && op.path === '') {
          throw new Error('a state patch may not move or copy onto the state root');
        }
      }
      JsonObjectSchema.parse(foldDelta(store.getState(), patch));
      store.applyDelta(patch);
    },
    setState: (pointer, value) => store.setLocal(pointer, value),
    pushState: (pointer, value) => {
      if (Array.isArray(store.getIn(pointer))) {
        store.applyDelta([{ op: 'add', path: `${pointer}/-`, value }]);
      } else {
        store.setLocal(pointer, [value]);
      }
    },
    removeState: (pointer, index) => {
      const current = store.getIn(pointer);
      if (
        !Array.isArray(current) ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= current.length
      ) {
        return;
      }
      store.applyDelta([{ op: 'remove', path: `${pointer}/${index}` }]);
    },
  };
}
