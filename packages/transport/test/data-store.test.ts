import { describe, it, expect } from 'vitest';
import { createDataStore } from '../src/state/data-store.js';
import type { JsonValue } from '@minitui/types';

const ESC = '\u001b'; // Real ESC byte; the store strips CSI at ingress.

describe('DataStore (canonical immutable state seam)', () => {
  it('seeds from initial and reads via getIn', () => {
    const store = createDataStore({ initial: { merge: { progress: 0 } } });
    expect(store.getIn('/merge/progress')).toBe(0);
  });

  it('applySnapshot strips model ANSI and replaces state', () => {
    const store = createDataStore();
    store.applySnapshot({ title: `a${ESC}[0mb` });
    expect(store.getState()).toEqual({ title: 'ab' }); // CSI stripped on ingress (deep/immutable covered below)
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

  it('setLocal suppresses a same-value write with no notification', () => {
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

  it('setLocal strips model ANSI from a string value, symmetric with applyDelta/applySnapshot', () => {
    const store = createDataStore({ initial: {} });
    store.setLocal('/title', `a${ESC}[0mb`);
    expect(store.getState()).toEqual({ title: 'ab' }); // CSI stripped at ingress like the delta path
  });

  it('setLocal deep-strips ANSI from nested string values (the walker, not a top-level-only strip)', () => {
    const store = createDataStore({ initial: {} });
    store.setLocal('/node', { label: `x${ESC}[1my`, tags: [`p${ESC}[0mq`] });
    // A bare string-only strip would leave the nested object/array untouched; the walker cleans
    // every string leaf at any depth, matching foldDelta/foldSnapshot.
    expect(store.getState()).toEqual({ node: { label: 'xy', tags: ['pq'] } });
  });
});

// A pathological nesting far past MAX_DEPTH (256): plain recursive walks
// (JsonValueSchema.safeParse, sanitizeStrings) RangeError on this without a guard.
function deepNest(depth: number): JsonValue {
  let node: JsonValue = 1;
  for (let i = 0; i < depth; i++) node = { next: node };
  return node;
}

// A REAL capturing DiagnosticsPort (records warn messages + their meta into owned
// arrays), matching the injected-port pattern the app-bus drop-counter test uses — no mock.
function capturingDiagnostics(): {
  warnings: string[];
  metas: Array<Record<string, unknown> | undefined>;
  diagnostics: { warn(m: string, meta?: Record<string, unknown>): void; debug(): void };
} {
  const warnings: string[] = [];
  const metas: Array<Record<string, unknown> | undefined> = [];
  return {
    warnings,
    metas,
    diagnostics: {
      warn: (m: string, meta?: Record<string, unknown>) => {
        warnings.push(m);
        metas.push(meta);
      },
      debug() {},
    },
  };
}

describe('DataStore ownership and delivery', () => {
  it('clones opts.initial on ingress so later caller mutation cannot reach canonical state', () => {
    const initial = { counter: { value: 1 } };
    const store = createDataStore({ initial });
    initial.counter.value = 2; // caller mutates their OWN retained reference after construction
    expect(store.getState()).toEqual({ counter: { value: 1 } });
  });

  it('clones a setLocal value on ingress so later caller mutation cannot reach canonical state', () => {
    const store = createDataStore({ initial: {} });
    const value = { label: 'one' };
    store.setLocal('/item', value);
    value.label = 'two'; // caller mutates their OWN retained reference after setLocal returns
    expect(store.getState()).toEqual({ item: { label: 'one' } });
  });

  it('getState returns a deeply frozen snapshot that cannot corrupt a later delivery', () => {
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

  it('isolates a throwing subscriber and never mislabels a committed delta as dropped', () => {
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

  it('serializes reentrant commits so every subscriber sees snapshots in commit order', () => {
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

  it('keeps getState coherent with the snapshot currently being delivered', () => {
    const store = createDataStore({ initial: { n: 0 } });
    const coherence: Array<readonly [JsonValue, JsonValue]> = [];
    let reentered = false;
    store.subscribe((snapshot) => {
      if (!reentered) {
        reentered = true;
        store.setLocal('/n', 2);
      }
      coherence.push([snapshot, store.getState()]);
    });
    store.setLocal('/n', 1);
    expect(coherence).toEqual([
      [{ n: 1 }, { n: 1 }],
      [{ n: 2 }, { n: 2 }],
    ]);
  });

  it('derives independent reentrant writes from the newest staged snapshot', () => {
    const store = createDataStore({ initial: { trigger: false } });
    let wrote = false;
    store.subscribe(() => {
      if (wrote) return;
      wrote = true;
      store.setLocal('/left', 1);
      store.setLocal('/right', 2);
    });
    store.setLocal('/trigger', true);
    expect(store.getState()).toEqual({ trigger: true, left: 1, right: 2 });
  });

  it('treats a staged null snapshot as authoritative during reentrant writes', () => {
    const store = createDataStore({ initial: { trigger: false } });
    let wrote = false;
    store.subscribe(() => {
      if (wrote) return;
      wrote = true;
      store.applySnapshot(null);
      store.setLocal('/x', 1);
    });

    store.setLocal('/trigger', true);
    expect(store.getState()).toEqual({ x: 1 });
  });

  it('suppresses equivalent snapshots, empty deltas, and missing removals', () => {
    const store = createDataStore({ initial: { value: 1 } });
    let notifications = 0;
    store.subscribe(() => {
      notifications++;
    });
    store.applySnapshot({ value: 1 });
    store.applyDelta([]);
    store.removeLocal('/missing');
    expect(notifications).toBe(0);
  });

  it('stops delivering to a subscriber once its returned unsubscribe is called', () => {
    const store = createDataStore({ initial: { n: 0 } });
    const seen: JsonValue[] = [];
    const unsubscribe = store.subscribe((snapshot) => {
      seen.push(snapshot);
    });
    store.setLocal('/n', 1);
    unsubscribe();
    store.setLocal('/n', 2);
    expect(seen).toEqual([{ n: 1 }]); // the post-unsubscribe commit is NOT delivered
    expect(store.getState()).toEqual({ n: 2 }); // ...though it still committed
  });

  it('removeLocal drops an EXISTING key and notifies once', () => {
    const store = createDataStore({ initial: { keep: 1, drop: 2 } });
    const seen: JsonValue[] = [];
    store.subscribe((snapshot) => {
      seen.push(snapshot);
    });
    store.removeLocal('/drop');
    expect(store.getState()).toEqual({ keep: 1 }); // the sibling key survives
    expect(seen).toEqual([{ keep: 1 }]); // exactly one delivery, carrying the new state
  });

  it('isolates asynchronous subscriber rejection and continues sibling delivery', async () => {
    const { warnings, diagnostics } = capturingDiagnostics();
    const store = createDataStore({ initial: {}, diagnostics });
    const seen: JsonValue[] = [];
    store.subscribe(async () => {
      throw new Error('async subscriber boom');
    });
    store.subscribe((snapshot) => {
      seen.push(snapshot);
    });
    store.setLocal('/ok', true);
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([{ ok: true }]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('formats hostile thrown values without breaking sibling delivery', () => {
    const { warnings, diagnostics } = capturingDiagnostics();
    const store = createDataStore({ initial: {}, diagnostics });
    let siblingCalls = 0;
    store.subscribe(() => {
      throw Object.create(null);
    });
    store.subscribe(() => {
      siblingCalls++;
    });
    expect(() => store.setLocal('/ok', true)).not.toThrow();
    expect(siblingCalls).toBe(1);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('applySnapshot fails closed without a RangeError on pathologically deep input', () => {
    const { warnings, diagnostics } = capturingDiagnostics();
    const store = createDataStore({ initial: { ok: true }, diagnostics });
    expect(() => store.applySnapshot(deepNest(6000))).not.toThrow(); // no uncaught RangeError
    expect(store.getState()).toEqual({ ok: true }); // dropped; canonical state unchanged
    expect(warnings.length).toBeGreaterThan(0); // a diagnostic was surfaced
  });

  it('setLocal fails closed without a RangeError on a pathologically deep value', () => {
    const { warnings, diagnostics } = capturingDiagnostics();
    const store = createDataStore({ initial: {}, diagnostics });
    expect(() => store.setLocal('/deep', deepNest(6000))).not.toThrow();
    expect(store.getState()).toEqual({}); // dropped; canonical state unchanged
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('re-parses on commit and drops a copy from constructor that injects Object', () => {
    const { warnings, diagnostics } = capturingDiagnostics();
    const store = createDataStore({ initial: { safe: 1 }, diagnostics });
    store.applyDelta([{ op: 'copy', from: '/constructor', path: '/x' }]);
    expect(store.getState()).toEqual({ safe: 1 }); // the ctor-injecting commit is DROPPED
    expect(store.getIn('/x')).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('re-parses on commit and drops a setLocal write with a reserved key', () => {
    const { warnings, diagnostics } = capturingDiagnostics();
    const store = createDataStore({ initial: { safe: 1 }, diagnostics });
    store.setLocal('/constructor', 'evil');
    expect(store.getState()).toEqual({ safe: 1 }); // the reserved-key write is DROPPED
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('getIn drops with a diagnostic instead of throwing on an invalid pointer', () => {
    const { warnings, diagnostics } = capturingDiagnostics();
    const store = createDataStore({ initial: { safe: 1 }, diagnostics });
    // Every other read/write path on this port drops-with-diagnostic; getIn must match.
    expect(() => store.getIn('/constructor')).not.toThrow();
    expect(store.getIn('/constructor')).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('reports the original error value, not just its formatted message, through diagnostics', () => {
    const { metas, diagnostics } = capturingDiagnostics();
    const store = createDataStore({ initial: { safe: 1 }, diagnostics });
    store.setLocal('/constructor', 'evil');
    const reported = metas[metas.length - 1]?.cause;
    expect(reported).toBeInstanceOf(Error); // the raw error, not a flattened string
    expect((reported as Error).message).toBe('reserved state key not allowed: constructor');
  });
});
