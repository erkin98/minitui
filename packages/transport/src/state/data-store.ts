import { type JsonValue, isArrayValue, isObject, getIn, setIn, removeIn } from './json-pointer.js';
import { type JsonPatchOp } from './patch-apply.js';
import { foldSnapshot, foldDelta } from './snapshot-delta.js';
import type { StorePort } from './store-port.js';
import { JsonValueSchema, type DiagnosticsPort } from '@minitui/types';
import { isDeepStrictEqual } from 'node:util';

export interface DataStore extends StorePort {
  applySnapshot(snapshot: JsonValue): void;
  applyDelta(delta: readonly JsonPatchOp[]): void;
  setLocal(pointer: string, value: JsonValue): void;
  removeLocal(pointer: string): void;
}

// PIN-DEPTH (fold): bounded fail-closed, not RangeError. 256 is far above any real
// spec/state nesting and far below stack exhaustion (~1000s); a cycle exceeds it too.
const MAX_DEPTH = 256;

// Bounded-recursion depth probe over an untrusted JSON value: returns true (reject)
// the instant the ceiling is passed, so it NEVER recurses deep enough to RangeError —
// unlike the raw safeParse / sanitizeStrings walks it guards ahead of.
function exceedsDepth(value: JsonValue, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true;
  if (isArrayValue(value)) {
    for (const v of value) if (exceedsDepth(v, depth + 1)) return true;
    return false;
  }
  if (isObject(value)) {
    for (const v of Object.values(value)) if (exceedsDepth(v, depth + 1)) return true;
    return false;
  }
  return false;
}

// Prototype-safe deep clone of a bounded (<= MAX_DEPTH, caller-checked) JSON value.
// PIN-STATE-OWNERSHIP #1 (ingress clone): a caller-owned value is copied so a later
// mutation of the caller's retained reference can never reach into canonical state.
// Keys are written as OWN data properties (defineProperty) so an own `__proto__` key
// cannot trip the prototype setter (§Z100) — the same clone shape as sanitizeStrings.
function cloneJson(value: JsonValue): JsonValue {
  if (isArrayValue(value)) return value.map((v) => cloneJson(v));
  if (isObject(value)) {
    const out: { [k: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value)) {
      Object.defineProperty(out, k, {
        value: cloneJson(v),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

export function createDataStore(opts?: {
  initial?: JsonValue;
  diagnostics?: DiagnosticsPort;
}): DataStore {
  const diagnostics = opts?.diagnostics;
  // Canonical state is always a value that was validated + frozen by `commit` (or the
  // frozen empty default), so `getState()` returns a deeply-frozen live ref: copy-on-read
  // stays dropped, yet an egress caller cannot mutate it (closes the state-05 footgun).
  let state: JsonValue = Object.freeze({});
  const subs = new Set<(s: JsonValue) => void>();

  // Single global-FIFO delivery (mirrors app-bus): a commit triggered re-entrantly from
  // inside a subscriber only ENQUEUES its snapshot and returns; the outermost commit owns
  // the drain, so every subscriber observes snapshots in commit order (never a reordered
  // [2,2]). Each subscriber call is isolated — a thrower is logged and skipped, never
  // starving later subscribers and never mislabeled downstream as a dropped delta (C04).
  const pending: JsonValue[] = [];
  let delivering = false;

  // The sole canonical-state chokepoint. PIN-STATE-OWNERSHIP #2: every folded doc is
  // re-parsed through JsonValueSchema before it becomes canonical — a non-JSON value (an
  // injected live ctor from `copy`/`move` /constructor) or a reserved key is DROPPED, never
  // committed; the parse also returns a FRESH, deeply-frozen tree so canonical state shares
  // no reference with any ingress value or prior getState() result. PIN-DEPTH: reject before
  // the parse so a pathological (or patch-composed) nesting fails closed here, not a RangeError.
  const commit = (next: JsonValue): void => {
    if (exceedsDepth(next)) {
      diagnostics?.warn('dropped state commit exceeding max nesting depth', {
        maxDepth: MAX_DEPTH,
      });
      return;
    }
    const parsed = JsonValueSchema.safeParse(next);
    if (!parsed.success) {
      diagnostics?.warn('dropped state commit: value is not a valid JsonValue', {
        reason: parsed.error.issues[0]?.message,
      });
      return;
    }
    state = parsed.data;
    pending.push(state);
    if (delivering) return;
    delivering = true;
    try {
      for (let snap = pending.shift(); snap !== undefined; snap = pending.shift()) {
        // Stable per-snapshot fan-out list: a subscribe/unsubscribe during delivery does not
        // disturb the in-progress pass; each callback is isolated so one thrower cannot starve
        // the rest or abort the drain.
        for (const fn of [...subs]) {
          try {
            fn(snap);
          } catch (err) {
            diagnostics?.warn('state subscriber threw (isolated)', { error: String(err) });
          }
        }
      }
    } finally {
      delivering = false;
    }
  };

  if (opts?.initial !== undefined) {
    if (exceedsDepth(opts.initial)) {
      diagnostics?.warn('dropped initial state exceeding max nesting depth', {
        maxDepth: MAX_DEPTH,
      });
    } else {
      commit(cloneJson(opts.initial));
    }
  }

  return {
    getState: () => state,
    getIn: (pointer) => getIn(state, pointer),
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    applySnapshot(snapshot) {
      // Untrusted model snapshot. Depth-guard BEFORE folding: foldSnapshot's recursive sanitize
      // would otherwise RangeError on a pathological nesting — fail closed with a diagnostic instead.
      if (exceedsDepth(snapshot)) {
        diagnostics?.warn('dropped snapshot exceeding max nesting depth', { maxDepth: MAX_DEPTH });
        return;
      }
      commit(foldSnapshot(snapshot));
    },
    applyDelta(delta) {
      // Untrusted model-authored delta: foldDelta sanitizes then applies (§Z11). A patch that
      // fails RFC-6902 validation (bad path, banned prototype op) is DROPPED with a diagnostic
      // (§Z5) — state stays unchanged — rather than throwing and crashing the fold loop. Depth-guard
      // each op value first (fail closed with a precise diagnostic, not a RangeError from sanitize);
      // subscriber failures are isolated inside commit, so this catch can only mean the delta itself
      // was invalid — never a subscriber throw mislabeled as a dropped delta.
      if (delta.some((op) => 'value' in op && exceedsDepth(op.value))) {
        diagnostics?.warn('dropped state delta exceeding max nesting depth', {
          maxDepth: MAX_DEPTH,
        });
        return;
      }
      try {
        commit(foldDelta(state, delta));
      } catch (err) {
        diagnostics?.warn('dropped invalid state delta', { error: String(err) });
      }
    },
    setLocal(pointer, value) {
      // PIN-DEPTH: reject a pathological value before it reaches the recursive clone/parse.
      if (exceedsDepth(value)) {
        diagnostics?.warn('dropped setLocal value exceeding max nesting depth', {
          maxDepth: MAX_DEPTH,
        });
        return;
      }
      // Fail closed: the PIN-POINTER helpers (getIn/setIn) THROW on a malformed or reserved-key
      // pointer; a local write that hits one is DROPPED with a diagnostic, never propagated.
      try {
        // §Z30 same-value suppression: runtime-host requires setLocal to be a NO-OP (no subscriber
        // notification, no new doc) when the write does not change the pointer's value — a controlled
        // widget re-emitting its current value must not fire a spurious re-render/echo loop. Compare
        // before committing (node:util deep-equal, correct on nested/array values).
        if (isDeepStrictEqual(getIn(state, pointer), value)) return;
        // PIN-STATE-OWNERSHIP #1: clone the caller-owned value at ingress so a later mutation of their
        // retained reference cannot reach canonical state (the commit re-parse is the second barrier).
        commit(setIn(state, pointer, cloneJson(value)));
      } catch (err) {
        diagnostics?.warn('dropped invalid setLocal write', { error: String(err) });
      }
    },
    removeLocal(pointer) {
      try {
        commit(removeIn(state, pointer));
      } catch (err) {
        diagnostics?.warn('dropped invalid removeLocal', { error: String(err) });
      }
    },
  };
}
