import { describe, it, expect } from 'vitest';
import { applyStatePatch, PatchError } from '../src/state/patch-apply.js';
import type { JsonValue } from '../src/state/json-pointer.js';

describe('applyStatePatch', () => {
  it('applies a valid RFC-6902 delta into a NEW document', () => {
    const state: JsonValue = { merge: { progress: 0 } };
    const next = applyStatePatch(state, [{ op: 'replace', path: '/merge/progress', value: 42 }]);
    expect(next).toEqual({ merge: { progress: 42 } });
    expect(state).toEqual({ merge: { progress: 0 } }); // input untouched (mutateDocument:false)
  });

  it('rejects a malformed op at apply time with PatchError', () => {
    expect(() =>
      applyStatePatch({ a: 1 }, [{ op: 'replace', path: '/nope/deep', value: 1 }]),
    ).toThrow(PatchError);
  });

  it('rejects prototype-pollution paths (banPrototypeModifications)', () => {
    expect(() =>
      applyStatePatch({}, [{ op: 'add', path: '/__proto__/polluted', value: true }]),
    ).toThrow(PatchError);
    // global prototype is NOT polluted
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects a copy/move whose `from` reads a non-own (inherited) member', () => {
    // banPrototypeModifications only bans writes; a copy/move `from` reads the pointer,
    // so `/constructor` (or any inherited member) would return a live host function and inject it
    // into JsonValue-typed canonical state. Reject before applying.
    for (const from of ['/constructor', '/toString', '/valueOf']) {
      expect(() => applyStatePatch({}, [{ op: 'copy', from, path: '/x' }])).toThrow(PatchError);
      expect(() => applyStatePatch({}, [{ op: 'move', from, path: '/x' }])).toThrow(PatchError);
    }
    // deep inherited read is rejected at any nesting
    expect(() =>
      applyStatePatch({ node: {} }, [{ op: 'move', from: '/node/constructor', path: '/leak' }]),
    ).toThrow(PatchError);
    // and the injection provably does not happen
    expect(() => applyStatePatch({}, [{ op: 'copy', from: '/constructor', path: '/x' }])).toThrow(
      PatchError,
    );
  });

  it('still applies a copy/move from a legitimate OWN member', () => {
    expect(applyStatePatch({ a: { n: 1 } }, [{ op: 'copy', from: '/a', path: '/b' }])).toEqual({
      a: { n: 1 },
      b: { n: 1 },
    });
    expect(applyStatePatch({ a: 1, b: 2 }, [{ op: 'move', from: '/a', path: '/c' }])).toEqual({
      b: 2,
      c: 1,
    });
  });

  it('does not mutate a patch op value object even when the patch fails', () => {
    // fast-json-patch inserts op.value by reference, so a later op mutating that path reaches
    // back into the caller-owned operand. applyStatePatch must clone each op before applying.
    const operandValue = { n: 1 };
    expect(() =>
      applyStatePatch({ base: 1 }, [
        { op: 'add', path: '/x', value: operandValue },
        { op: 'replace', path: '/x/n', value: 2 },
        { op: 'remove', path: '/missing' },
      ]),
    ).toThrow(PatchError);
    expect(operandValue).toEqual({ n: 1 }); // caller operand untouched
  });

  it('reports the failing op index in PatchError.opIndex', () => {
    // fast-json-patch reports the wrong internal index, so this wrapper tracks each operation.
    let caught: unknown;
    try {
      applyStatePatch({ base: 1 }, [
        { op: 'add', path: '/x', value: { n: 1 } },
        { op: 'replace', path: '/x/n', value: 2 },
        { op: 'remove', path: '/missing' },
      ]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PatchError);
    expect((caught as PatchError).opIndex).toBe(2);
  });

  it('fails closed (PatchError, not an uncaught RangeError) on a stack-exhausting document', () => {
    let deep: JsonValue = {};
    for (let i = 0; i < 8000; i++) deep = { next: deep };
    expect(() => applyStatePatch(deep, [])).toThrow(PatchError);
  });

  it('rejects a non-array delta with PatchError', () => {
    expect(() => applyStatePatch({}, 'not-an-array')).toThrow(PatchError);
  });

  it('parses the complete patch schema before cloning or applying and reports its issue index', () => {
    let caught: unknown;
    try {
      applyStatePatch({}, [
        { op: 'add', path: '/ok', value: 1 },
        { op: 'add', path: '/bad', value: 1n },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PatchError);
    expect((caught as PatchError).opIndex).toBe(1);
    expect(() => applyStatePatch({}, [{ op: 'replace', path: '/x', value: undefined }])).toThrow(
      PatchError,
    );
  });

  it('rejects non-canonical and unsafe array indices for every target operation', () => {
    for (const path of ['/items/01', '/items/+1', '/items/9007199254740992']) {
      expect(() => applyStatePatch({ items: [1, 2] }, [{ op: 'add', path, value: 3 }])).toThrow(
        PatchError,
      );
      expect(() => applyStatePatch({ items: [1, 2] }, [{ op: 'remove', path }])).toThrow(
        PatchError,
      );
    }
  });

  it('rejects inherited or missing replace targets instead of treating them as members', () => {
    expect(() => applyStatePatch({}, [{ op: 'replace', path: '/toString', value: 1 }])).toThrow(
      PatchError,
    );
    expect(() => applyStatePatch({}, [{ op: 'replace', path: '/missing', value: 1 }])).toThrow(
      PatchError,
    );
  });

  it('rejects a move from an ancestor into its strict descendant, including the root', () => {
    expect(() =>
      applyStatePatch({ a: { b: 1 } }, [{ op: 'move', from: '/a', path: '/a/new' }]),
    ).toThrow(PatchError);
    expect(() => applyStatePatch({ a: 1 }, [{ op: 'move', from: '', path: '/child' }])).toThrow(
      PatchError,
    );
  });

  it('rejects dirty or reserved path tokens even beyond a missing ancestor', () => {
    for (const path of ['/missing/__proto__', '/safe/na\u001b[31mme']) {
      expect(() => applyStatePatch({}, [{ op: 'add', path, value: 1 }])).toThrow(PatchError);
    }
  });

  it('preflights each operation against the evolving private document', () => {
    expect(
      applyStatePatch({}, [
        { op: 'add', path: '/node', value: {} },
        { op: 'add', path: '/node/value', value: 1 },
        { op: 'replace', path: '/node/value', value: 2 },
      ]),
    ).toEqual({ node: { value: 2 } });
  });
});
