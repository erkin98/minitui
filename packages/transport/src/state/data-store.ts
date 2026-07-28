import { isDeepStrictEqual } from 'node:util';
import { JsonValueSchema, type DiagnosticsPort } from '@minitui/types';
import { formatUnknown } from '../format-unknown.js';
import {
  assertCanonicalStateValue,
  getIn,
  removeIn,
  setIn,
  type JsonValue,
} from './json-pointer.js';
import { type JsonPatchOp } from './patch-apply.js';
import { foldDelta, foldSnapshot } from './snapshot-delta.js';
import type { StorePort, StoreSubscriber } from './store-port.js';

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
  const diagnostics = opts?.diagnostics;
  const subscribers = new Set<StoreSubscriber>();
  const pending: JsonValue[] = [];
  let pendingHead = 0;
  let delivering = false;
  let state: JsonValue = JsonValueSchema.parse({});

  const report = (message: string, error: unknown): void => {
    try {
      diagnostics?.warn(message, { error: formatUnknown(error) });
    } catch {
      // Diagnostics is observational and cannot break state delivery.
    }
  };

  const canonicalize = (value: unknown, label: string): JsonValue | undefined => {
    const parsed = JsonValueSchema.safeParse(value);
    if (!parsed.success) {
      report(label, parsed.error);
      return undefined;
    }
    try {
      assertCanonicalStateValue(parsed.data);
      return parsed.data;
    } catch (error) {
      report(label, error);
      return undefined;
    }
  };

  const stagedState = (): JsonValue => pending.at(-1) ?? state;

  const deliver = (): void => {
    if (delivering) return;
    delivering = true;
    try {
      while (pendingHead < pending.length) {
        const snapshot = pending[pendingHead++]!;
        state = snapshot;
        for (const subscriber of [...subscribers]) {
          try {
            const result = subscriber(snapshot);
            if (result !== undefined) {
              void Promise.resolve(result).catch((error: unknown) => {
                report('state subscriber rejected (isolated)', error);
              });
            }
          } catch (error) {
            report('state subscriber threw (isolated)', error);
          }
        }
      }
    } finally {
      pending.length = 0;
      pendingHead = 0;
      delivering = false;
    }
  };

  const commit = (candidate: JsonValue): void => {
    const canonical = canonicalize(candidate, 'dropped state commit');
    if (canonical === undefined || isDeepStrictEqual(canonical, stagedState())) return;
    pending.push(canonical);
    deliver();
  };

  if (opts?.initial !== undefined) {
    state = canonicalize(opts.initial, 'dropped invalid initial state') ?? state;
  }

  return {
    getState: () => state,
    getIn: (pointer) => getIn(state, pointer),
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    applySnapshot(snapshot) {
      try {
        commit(foldSnapshot(snapshot));
      } catch (error) {
        report('dropped invalid state snapshot', error);
      }
    },
    applyDelta(delta) {
      try {
        commit(foldDelta(stagedState(), delta));
      } catch (error) {
        report('dropped invalid state delta', error);
      }
    },
    setLocal(pointer, value) {
      try {
        const canonicalValue = canonicalize(value, 'dropped invalid setLocal value');
        if (canonicalValue === undefined) return;
        commit(setIn(stagedState(), pointer, canonicalValue));
      } catch (error) {
        report('dropped invalid setLocal write', error);
      }
    },
    removeLocal(pointer) {
      try {
        commit(removeIn(stagedState(), pointer));
      } catch (error) {
        report('dropped invalid removeLocal', error);
      }
    },
  };
}
