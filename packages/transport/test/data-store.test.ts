import { describe, it, expect } from 'vitest';
import { createDataStore } from '../src/state/data-store.js';
import type { JsonValue } from '@minitui/types';

const ESC = '\u001b'; // real ESC byte — sanitize (imported directly by snapshot-delta, §Z11) strips CSI at the store ingress

describe('DataStore (canonical immutable state seam)', () => {
  it('seeds from initial and reads via getIn', () => {
    const store = createDataStore({ initial: { merge: { progress: 0 } } });
    expect(store.getIn('/merge/progress')).toBe(0);
  });

  it('applySnapshot strips model ANSI and replaces state', () => {
    const store = createDataStore();
    store.applySnapshot({ title: `a${ESC}[0mb` });
    expect(store.getState()).toEqual({ title: 'ab' }); // CSI stripped on ingress (Task 6 covers deep/immutable)
  });

  it('applyDelta folds an RFC-6902 patch and notifies subscribers', () => {
    const store = createDataStore({ initial: { p: 0 } });
    const seen: unknown[] = [];
    store.subscribe((s) => {
      seen.push(s);
    });
    store.applyDelta([{ op: 'replace', path: '/p', value: 9 }]);
    expect(store.getState()).toEqual({ p: 9 });
    expect(seen).toEqual([{ p: 9 }]);
  });

  it('setLocal mutates the SAME canonical doc immutably (new object each time)', () => {
    const store = createDataStore({ initial: {} });
    const before = store.getState();
    store.setLocal('/codec', 'h264');
    expect(store.getState()).toEqual({ codec: 'h264' });
    expect(store.getState()).not.toBe(before);
  });

  it('setLocal suppresses a same-value write: no notify, same doc (§Z30)', () => {
    const store = createDataStore({ initial: { codec: 'h264' } });
    let notifications = 0;
    store.subscribe(() => {
      notifications++;
    });
    const before = store.getState();
    store.setLocal('/codec', 'h264'); // identical value -> no-op
    expect(notifications).toBe(0); // subscribers NOT notified
    expect(store.getState()).toBe(before); // no new object committed
    store.setLocal('/codec', 'vp9'); // a real change still commits + notifies
    expect(notifications).toBe(1);
    expect(store.getState()).toEqual({ codec: 'vp9' });
  });
});

// A pathological nesting far past MAX_DEPTH (256): the pre-fold recursive walks
// (JsonValueSchema.safeParse, sanitizeStrings) RangeError on this without a guard.
function deepNest(depth: number): JsonValue {
  let node: JsonValue = 1;
  for (let i = 0; i < depth; i++) node = { next: node };
  return node;
}

// A REAL capturing DiagnosticsPort (records warn messages into an owned array),
// matching the injected-port pattern the app-bus drop-counter test uses — no mock.
function capturingDiagnostics(): {
  warnings: string[];
  diagnostics: { warn(m: string): void; debug(): void };
} {
  const warnings: string[] = [];
  return {
    warnings,
    diagnostics: {
      warn: (m: string) => {
        warnings.push(m);
      },
      debug() {},
    },
  };
}

describe('DataStore fold hardening (C03/C04/state-05 · PIN-STATE-OWNERSHIP/DEPTH)', () => {
  it('clones opts.initial on ingress: a later caller mutation cannot reach canonical state (C03)', () => {
    const initial = { counter: { value: 1 } };
    const store = createDataStore({ initial });
    initial.counter.value = 2; // caller mutates their OWN retained reference after construction
    expect(store.getState()).toEqual({ counter: { value: 1 } });
  });

  it('clones a setLocal value on ingress: a later caller mutation cannot reach canonical state (C03)', () => {
    const store = createDataStore({ initial: {} });
    const value = { label: 'one' };
    store.setLocal('/item', value);
    value.label = 'two'; // caller mutates their OWN retained reference after setLocal returns
    expect(store.getState()).toEqual({ item: { label: 'one' } });
  });

  it('getState returns a deeply-frozen snapshot; a post-getState mutation cannot corrupt a later delivery (state-05)', () => {
    const store = createDataStore({ initial: { a: { x: 1 } } });
    const leaked = store.getState();
    expect(Object.isFrozen(leaked)).toBe(true); // top-level frozen
    expect(Object.isFrozen(store.getIn('/a'))).toBe(true); // deep-frozen — the egress ref cannot be mutated
    expect(Object.isExtensible(leaked)).toBe(false); // no property can be added onto the leaked ref
    const seen: JsonValue[] = [];
    store.subscribe((s) => {
      seen.push(s);
    });
    store.setLocal('/a/x', 2);
    expect(seen).toEqual([{ a: { x: 2 } }]); // the next delivery is clean
    expect(store.getState()).not.toBe(leaked); // and a fresh tree, sharing nothing with the leaked ref
  });

  it('isolates a throwing subscriber and never mislabels a committed delta as dropped (C04)', () => {
    const { warnings, diagnostics } = capturingDiagnostics();
    const store = createDataStore({ initial: { p: 0 }, diagnostics });
    const secondSeen: JsonValue[] = [];
    store.subscribe(() => {
      throw new Error('subscriber boom');
    });
    store.subscribe((s) => {
      secondSeen.push(s);
    });
    store.applyDelta([{ op: 'replace', path: '/p', value: 9 }]);
    expect(store.getState()).toEqual({ p: 9 }); // the (valid) delta DID commit
    expect(secondSeen).toEqual([{ p: 9 }]); // the second subscriber still ran
    expect(warnings).not.toContain('dropped invalid state delta'); // and was NOT mislabeled
  });

  it('serializes reentrant commits so every subscriber sees snapshots in commit order (C04)', () => {
    const store = createDataStore({ initial: { n: 0 } });
    const bSnapshots: JsonValue[] = [];
    let reentered = false;
    store.subscribe((s) => {
      // A: on the first delivered snapshot (n=1) trigger a reentrant commit to n=2
      if (!reentered && JSON.stringify(s) === JSON.stringify({ n: 1 })) {
        reentered = true;
        store.setLocal('/n', 2);
      }
    });
    store.subscribe((s) => {
      bSnapshots.push(s); // B records each snapshot it receives
    });
    store.setLocal('/n', 1);
    // B must see 1 THEN 2 in commit order — the unserialized bug delivers [2,2] (B never sees 1).
    expect(bSnapshots).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('applySnapshot fails closed (no RangeError) on pathologically deep input (PIN-DEPTH)', () => {
    const { warnings, diagnostics } = capturingDiagnostics();
    const store = createDataStore({ initial: { ok: true }, diagnostics });
    expect(() => store.applySnapshot(deepNest(6000))).not.toThrow(); // no uncaught RangeError
    expect(store.getState()).toEqual({ ok: true }); // dropped; canonical state unchanged
    expect(warnings.length).toBeGreaterThan(0); // a diagnostic was surfaced
  });

  it('setLocal fails closed (no RangeError) on a pathologically deep value (PIN-DEPTH)', () => {
    const { warnings, diagnostics } = capturingDiagnostics();
    const store = createDataStore({ initial: {}, diagnostics });
    expect(() => store.setLocal('/deep', deepNest(6000))).not.toThrow();
    expect(store.getState()).toEqual({}); // dropped; canonical state unchanged
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('re-parse on commit drops a copy-from-/constructor that injects the live Object ctor (patch-01)', () => {
    const { warnings, diagnostics } = capturingDiagnostics();
    const store = createDataStore({ initial: { safe: 1 }, diagnostics });
    store.applyDelta([{ op: 'copy', from: '/constructor', path: '/x' }]);
    expect(store.getState()).toEqual({ safe: 1 }); // the ctor-injecting commit is DROPPED
    expect(store.getIn('/x')).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('re-parse on commit drops a setLocal writing a reserved key (C05 non-JSON/reserved writes)', () => {
    const { warnings, diagnostics } = capturingDiagnostics();
    const store = createDataStore({ initial: { safe: 1 }, diagnostics });
    store.setLocal('/constructor', 'evil');
    expect(store.getState()).toEqual({ safe: 1 }); // the reserved-key write is DROPPED
    expect(warnings.length).toBeGreaterThan(0);
  });
});
