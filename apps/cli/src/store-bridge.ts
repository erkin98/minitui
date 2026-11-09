import { videoMergeCatalog } from '@minitui/catalog';
import type { DataStore, JsonPatchOp } from '@minitui/transport';
import { JsonObjectSchema, type ExecEvent } from '@minitui/types';

// The two state pointers the catalog declares for the merge action. A spec that binds merge must seed
// both, so a replace here always has a target.
const MERGE_STATUS = videoMergeCatalog.actionDefs.get('merge')?.statusPointers;
const PROGRESS_POINTER = MERGE_STATUS?.progress ?? '/merge/progress';
const STATUS_POINTER = MERGE_STATUS?.status ?? '/merge/status';

/** A status line longer than this is cut: one stderr line can be tens of thousands of characters. */
export const STATUS_CAP = 1_000;

/**
 * The hop from exec's progress events to the data model: each event becomes one state change, so the bound
 * progress bar and status line update live. The merge app is the only app, so the pointers are the ones
 * its catalog entry names. Standard output is not shown and is dropped.
 */
export function bindExecEventToStore(
  store: Pick<DataStore, 'applyDelta'>,
): (ev: ExecEvent) => void {
  return (ev) => {
    const delta: JsonPatchOp[] =
      ev.kind === 'progress'
        ? [{ op: 'replace', path: PROGRESS_POINTER, value: ev.value }]
        : ev.kind === 'exit'
          ? [
              {
                op: 'replace',
                path: STATUS_POINTER,
                value: ev.code === 0 ? 'done' : `failed (exit ${ev.code})`,
              },
            ]
          : ev.kind === 'stderr'
            ? [{ op: 'replace', path: STATUS_POINTER, value: ev.chunk.slice(0, STATUS_CAP) }]
            : [];
    if (delta.length > 0) store.applyDelta(delta);
  };
}

/**
 * A refused gated action shows in its own status line, so the person sees why nothing happened. Only an
 * action the catalog gives a status pointer is written; the reason is the host's or exec's fixed phrase,
 * and it is bounded like a stderr line.
 */
export function bindDenialToStore(
  store: Pick<DataStore, 'applyDelta'>,
): (denial: { readonly actionKey: string; readonly reason: string }) => void {
  return (denial) => {
    const pointer = videoMergeCatalog.actionDefs.get(denial.actionKey)?.statusPointers?.status;
    if (pointer === undefined) return;
    const value = `refused: ${denial.reason}`.slice(0, STATUS_CAP);
    store.applyDelta([{ op: 'replace', path: pointer, value }]);
  };
}

/**
 * The renderer's view of the one shared store: the raw getSnapshot / setSnapshot / subscribe it wraps
 * itself. Both directions go through the object schema, so the renderer's object-rooted state model needs
 * no cast; the cached snapshot advances only after a source has validated, so an invalid source never
 * leaves a stale one behind.
 */
export function createRendererStoreIo(dataStore: DataStore): {
  getSnapshot(): Record<string, unknown>;
  setSnapshot(next: Record<string, unknown>): void;
  subscribe(listener: () => void): () => void;
} {
  let sourceSnapshot = dataStore.getState();
  let rendererSnapshot: Record<string, unknown> = JsonObjectSchema.parse(sourceSnapshot);
  return {
    getSnapshot: () => {
      const current = dataStore.getState();
      if (current !== sourceSnapshot) {
        const parsed = JsonObjectSchema.parse(current);
        sourceSnapshot = current;
        rendererSnapshot = parsed;
      }
      return rendererSnapshot;
    },
    setSnapshot: (next) => dataStore.applySnapshot(JsonObjectSchema.parse(next)),
    subscribe: (listener) => dataStore.subscribe(() => listener()),
  };
}
