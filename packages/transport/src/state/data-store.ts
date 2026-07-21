import { type JsonValue, getIn, setIn, removeIn } from './json-pointer.js';
import { type JsonPatchOp } from './patch-apply.js';
import { foldSnapshot, foldDelta } from './snapshot-delta.js';
import type { StorePort } from './store-port.js';
import type { DiagnosticsPort } from '@minitui/types';
import { isDeepStrictEqual } from 'node:util';

export interface DataStore extends StorePort {
  applySnapshot(snapshot: JsonValue): void;
  applyDelta(delta: readonly JsonPatchOp[]): void;
  setLocal(pointer: string, value: JsonValue): void;
  removeLocal(pointer: string): void;
}

export function createDataStore(opts?: {
  initial?: JsonValue;
  diagnostics?: DiagnosticsPort;
}): DataStore {
  let state: JsonValue = opts?.initial ?? {};
  const subs = new Set<(s: JsonValue) => void>();

  const commit = (next: JsonValue): void => {
    state = next;
    for (const fn of subs) fn(state);
  };

  return {
    getState: () => state,
    getIn: (pointer) => getIn(state, pointer),
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    applySnapshot(snapshot) {
      commit(foldSnapshot(snapshot));
    },
    applyDelta(delta) {
      // Untrusted model-authored delta: foldDelta sanitizes then applies (§Z11). A patch that
      // fails RFC-6902 validation (bad path, banned prototype op) is DROPPED with a diagnostic
      // (§Z5) — state stays unchanged — rather than throwing and crashing the fold loop. This is
      // the store's drop-accounting emit at the transport untrusted-input boundary.
      try {
        commit(foldDelta(state, delta));
      } catch (err) {
        opts?.diagnostics?.warn('dropped invalid state delta', { error: String(err) });
      }
    },
    setLocal(pointer, value) {
      // §Z30 same-value suppression: runtime-host requires setLocal to be a NO-OP (no subscriber
      // notification, no new doc) when the write does not change the pointer's value — a controlled
      // widget re-emitting its current value must not fire a spurious re-render/echo loop. Compare
      // before committing (node:util deep-equal, correct on nested/array values).
      if (isDeepStrictEqual(getIn(state, pointer), value)) return;
      commit(setIn(state, pointer, value));
    },
    removeLocal(pointer) {
      commit(removeIn(state, pointer));
    },
  };
}
