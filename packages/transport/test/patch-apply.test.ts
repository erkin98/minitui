import { describe, it, expect } from 'vitest';
import { applyStatePatch, PatchError } from '../src/state/patch-apply.js';
import type { JsonValue } from '../src/state/json-pointer.js';

function repeatedRootCopies(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    op: 'copy' as const,
    from: '',
    path: `/copy${index}`,
  }));
}

describe('applyStatePatch', () => {
  it('applies a valid RFC-6902 delta into a NEW document', () => {
    const state: JsonValue = { merge: { progress: 0 } };
    const next = applyStatePatch(state, [{ op: 'replace', path: '/merge/progress', value: 42 }]);
    expect(next).toEqual({ merge: { progress: 42 } });
    expect(state).toEqual({ merge: { progress: 0 } }); // mutation is confined to a private clone
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

  it('preserves negative zero when copying a composite object', () => {
    const state: JsonValue = { source: { nested: { value: -0 } } };

    expect(applyStatePatch(state, [{ op: 'copy', from: '/source', path: '/copy' }])).toStrictEqual({
      source: { nested: { value: -0 } },
      copy: { nested: { value: -0 } },
    });
    expect(state).toStrictEqual({ source: { nested: { value: -0 } } });
  });

  it('preserves negative zero when copying a composite array', () => {
    const state: JsonValue = { source: [{ value: -0 }, -0] };

    expect(applyStatePatch(state, [{ op: 'copy', from: '/source', path: '/copy' }])).toStrictEqual({
      source: [{ value: -0 }, -0],
      copy: [{ value: -0 }, -0],
    });
    expect(state).toStrictEqual({ source: [{ value: -0 }, -0] });
  });

  it('preserves negative zero when copying from and to the document root', () => {
    const state: JsonValue = { source: { nested: -0 } };

    expect(applyStatePatch(state, [{ op: 'copy', from: '', path: '/copy' }])).toStrictEqual({
      source: { nested: -0 },
      copy: { source: { nested: -0 } },
    });
    expect(applyStatePatch(state, [{ op: 'copy', from: '/source', path: '' }])).toStrictEqual({
      nested: -0,
    });
    expect(state).toStrictEqual({ source: { nested: -0 } });
  });

  it('bounds repeated root-copy growth at the exact failing operation', () => {
    const state: JsonValue = { seed: true };
    expect(applyStatePatch(state, repeatedRootCopies(10))).toHaveProperty('copy9');
    const oversizedThenValid = [
      ...repeatedRootCopies(16),
      { op: 'test' as const, path: '/seed', value: true },
    ];

    let caught: unknown;
    try {
      applyStatePatch(state, oversizedThenValid);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PatchError);
    if (!(caught instanceof PatchError)) throw new Error('expected PatchError');
    expect(caught.opIndex).toBe(15);
    expect(state).toEqual({ seed: true });
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

  it('normalizes hostile patch reflection failures to PatchError', () => {
    const hostileOperation: Record<string, unknown> = {};
    Object.defineProperty(hostileOperation, 'op', {
      enumerable: true,
      get() {
        throw new Error('operation getter denied');
      },
    });
    const hostileArray = new Proxy([hostileOperation], {
      getOwnPropertyDescriptor() {
        throw new Error('array reflection denied');
      },
    });

    for (const [delta, expectedIndex] of [
      [[hostileOperation], 0],
      [hostileArray, -1],
    ] as const) {
      let caught: unknown;
      try {
        applyStatePatch({}, delta);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PatchError);
      expect((caught as PatchError).opIndex).toBe(expectedIndex);
    }
  });

  it('reports the known operation index for hostile operation and slot reflection', () => {
    const hostileOperation = new Proxy<Record<string, unknown>>(
      {},
      {
        getPrototypeOf() {
          throw new Error('operation reflection denied');
        },
      },
    );
    const hostileSlot: unknown[] = [];
    Object.defineProperty(hostileSlot, '0', {
      enumerable: true,
      get() {
        throw new Error('slot access denied');
      },
    });

    for (const delta of [[hostileOperation], hostileSlot]) {
      let caught: unknown;
      try {
        applyStatePatch({}, delta);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PatchError);
      expect((caught as PatchError).opIndex).toBe(0);
    }
  });

  it('validates a move destination against the post-removal array', () => {
    expect(() =>
      applyStatePatch({ items: ['a', 'b', 'c'] }, [
        { op: 'move', from: '/items/0', path: '/items/3' },
      ]),
    ).toThrow(PatchError);
    expect(
      applyStatePatch({ items: ['a', 'b', 'c'] }, [
        { op: 'move', from: '/items/0', path: '/items/2' },
      ]),
    ).toEqual({ items: ['b', 'c', 'a'] });
    expect(
      applyStatePatch({ items: ['a', 'b', 'c'] }, [
        { op: 'move', from: '/items/0', path: '/items/-' },
      ]),
    ).toEqual({ items: ['b', 'c', 'a'] });
  });

  it('supports removing the root and preserves negative zero through a no-op patch', () => {
    expect(applyStatePatch({ value: 1 }, [{ op: 'remove', path: '' }])).toBeNull();
    expect(Object.is(applyStatePatch(-0, []), -0)).toBe(true);
  });

  it('rejects a move destination that only goes out of bounds after removal shifts an ancestor index', () => {
    // from is a sibling of an intermediate (not final) token in path's own array: removal shrinks
    // that array from 3 elements to 2, so index 2 no longer exists to descend through. A
    // post-removal check that only special-cased the final token would miss this.
    const state: JsonValue = { items: [{ v: 1 }, { v: 2 }, { v: 3 }] };
    expect(() =>
      applyStatePatch(state, [{ op: 'move', from: '/items/0', path: '/items/2/v' }]),
    ).toThrow(PatchError);
  });

  it('clones the whole document once at ingress and never per move', () => {
    // Regression guard for the earlier full-document structuredClone + engine-apply + schema-parse
    // on every move: that shape re-materialized the entire document per move, so an untrusted
    // delta carrying many moves cost proportional to move-count times document size. The fix
    // projects each removal along the target pointer path and never re-derives the document, so
    // the whole document is structure-cloned exactly ONCE at ingress no matter how many moves the
    // patch carries. Counting whole-document clones is deterministic where the old wall-clock
    // threshold was flaky, and it reds the instant per-move cloning returns.
    const size = 5000;
    const state: JsonValue = { items: Array.from({ length: size }, (_, index) => index) };
    const moveCount = 256; // JSON_RESOURCE_LIMITS.maxPatchOperations
    const patch = Array.from({ length: moveCount }, () => ({
      op: 'move' as const,
      from: '/items/0',
      path: `/items/${size - 1}`,
    }));

    // A real, delegating structuredClone that counts clones of the whole { items } document and
    // passes everything else (the small per-operation clones) straight through to the genuine
    // implementation. Not a replacement double: the real structuredClone still does the work.
    const realStructuredClone = globalThis.structuredClone;
    const isWholeDocument = (value: unknown): boolean =>
      typeof value === 'object' &&
      value !== null &&
      'items' in value &&
      Array.isArray((value as { items: unknown }).items) &&
      (value as { items: unknown[] }).items.length >= size;
    let wholeDocumentClones = 0;
    globalThis.structuredClone = <T>(value: T): T => {
      if (isWholeDocument(value)) wholeDocumentClones += 1;
      return realStructuredClone(value);
    };

    let result: JsonValue;
    try {
      result = applyStatePatch(state, patch);
    } finally {
      globalThis.structuredClone = realStructuredClone;
    }

    expect(Array.isArray((result as { items: unknown }).items)).toBe(true);
    expect((result as { items: unknown[] }).items.length).toBe(size);
    // Exactly one whole-document clone (the ingress defensive copy). Re-introducing a per-move
    // full-document clone makes this scale with moveCount, so a value above 1 fails here.
    expect(wholeDocumentClones).toBe(1);
  });
});

const TEST_FAILED = 'invalid state delta: test operation failed';

describe('a failed test operation', () => {
  function failure(state: JsonValue, delta: unknown): PatchError {
    try {
      applyStatePatch(state, delta);
    } catch (error) {
      if (error instanceof PatchError) return error;
      throw error;
    }
    throw new Error('the patch was expected to fail');
  }

  it('reports a fixed string and the operation index, and never the document', () => {
    const sentinel = 'SENTINEL-DO-NOT-LEAK';
    const error = failure({ secret: sentinel, a: 1 }, [
      { op: 'replace', path: '/a', value: 2 },
      { op: 'test', path: '/secret', value: 'something else' },
    ]);
    expect(error.message).toBe(TEST_FAILED);
    expect(error.opIndex).toBe(1);
    expect(error.message).not.toContain(sentinel);
  });

  it('keeps the message the same size for a very large document', () => {
    const large: Record<string, JsonValue> = {};
    for (let i = 0; i < 20_000; i++) large[`key${i}`] = i;
    const error = failure(large, [{ op: 'test', path: '', value: {} }]);
    expect(error.message).toHaveLength(TEST_FAILED.length);
  });

  it('leaves a short message with no document text', () => {
    const error = failure({ password: 'hunter2', nested: { token: 'abc' } }, [
      { op: 'test', path: '/nested', value: { token: 'different' } },
    ]);
    expect(error.message.length).toBeLessThanOrEqual(80);
    expect(error.message).not.toContain('hunter2');
    expect(error.message).not.toContain('abc');
  });
});

// The comparator is the adopted engine's own, so a test operation decides exactly as the engine does.
describe('test operation comparison', () => {
  const passes = (document: JsonValue, operand: JsonValue): boolean => {
    try {
      applyStatePatch(document, [{ op: 'test', path: '', value: operand }]);
      return true;
    } catch (error) {
      if (error instanceof PatchError) return false;
      throw error;
    }
  };

  it.each<[string, JsonValue, JsonValue, boolean]>([
    ['-0 against 0', -0, 0, true],
    ['0 against -0', 0, -0, true],
    ['[0] against [-0]', [0], [-0], true],
    ['objects with the keys in another order', { a: 1, b: 2 }, { b: 2, a: 1 }, true],
    ['nested arrays and null', { a: [1, { b: null }] }, { a: [1, { b: null }] }, true],
    ['arrays in another order', [1, 2], [2, 1], false],
    ['null against a missing member', { a: null }, {}, false],
    ["'1' against 1", '1', 1, false],
    ['an array against an object', [], {}, false],
    ['[1] against {0: 1}', [1], { '0': 1 }, false],
  ])('%s', (_name, document, operand, expected) => {
    expect(passes(document, operand)).toBe(expected);
  });

  it('refuses a comparison of objects that own a key named hasOwnProperty, state unchanged', () => {
    const document: JsonValue = { hasOwnProperty: 1 };
    expect(passes(document, { hasOwnProperty: 1 })).toBe(false);
    expect(document).toEqual({ hasOwnProperty: 1 });
  });
});

// A long or hostile token in a patch path never reaches the error text.
describe('patch messages are fixed strings', () => {
  const LONG = 'x'.repeat(100_000);
  const hasControlByte = (text: string): boolean =>
    [...text].some((ch) => {
      const code = ch.codePointAt(0)!;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    });

  function messageOf(state: JsonValue, delta: unknown): string {
    try {
      applyStatePatch(state, delta);
    } catch (error) {
      if (error instanceof PatchError) return error.message;
      throw error;
    }
    throw new Error('the patch was expected to fail');
  }

  const rows: Array<[string, JsonValue, unknown, string]> = [
    [
      'an array member that does not exist',
      { arr: [1] },
      [{ op: 'replace', path: `/arr/${LONG}`, value: 1 }],
      'array member does not exist',
    ],
    [
      'an object member that does not exist',
      { a: {} },
      [{ op: 'replace', path: `/a/${LONG}`, value: 1 }],
      'object member does not exist',
    ],
    [
      'a bad add index',
      { arr: [1] },
      [{ op: 'add', path: `/arr/${LONG}`, value: 1 }],
      'invalid add array index',
    ],
    [
      'an array member that does not exist after a removal (bad token)',
      { src: 1, arr: [1, 2] },
      [{ op: 'move', from: '/src', path: `/arr/${LONG}/x` }],
      'array member does not exist',
    ],
    [
      'an array member that does not exist after a removal (out of range)',
      { src: 1, arr: [1, 2] },
      [{ op: 'move', from: '/src', path: '/arr/5/x' }],
      'array member does not exist',
    ],
    [
      'an object member that does not exist after a removal',
      { src: 1, o: {} },
      [{ op: 'move', from: '/src', path: `/o/${LONG}/x` }],
      'object member does not exist',
    ],
    [
      'a bad add index after a removal',
      { src: 1, arr: [1] },
      [{ op: 'move', from: '/src', path: `/arr/${LONG}` }],
      'invalid add array index',
    ],
  ];

  it.each(rows)('%s', (_name, state, delta, fixed) => {
    const message = messageOf(state, delta);
    expect(message).toBe(`invalid state delta: ${fixed}`);
    expect(message.length).toBeLessThanOrEqual(80);
    expect(hasControlByte(message)).toBe(false);
  });
});
