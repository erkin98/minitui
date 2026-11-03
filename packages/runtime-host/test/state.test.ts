import { describe, it, expect } from 'vitest';
import { createDataStore, foldDelta, type JsonPatchOp } from '@minitui/transport';
import { JsonObjectSchema, type DiagnosticsPort, type JsonValue } from '@minitui/types';
import { createHostState, type HostState } from '../src/state.js';

const mk = (initial: JsonValue): HostState => createHostState(createDataStore({ initial }));

// A real capturing diagnostics port: the store logs a write it drops instead of throwing.
function mkLogged(initial: JsonValue): { s: HostState; warnings: string[] } {
  const warnings: string[] = [];
  const diagnostics: DiagnosticsPort = {
    warn: (msg) => {
      warnings.push(msg);
    },
    debug: () => {},
  };
  return { s: createHostState(createDataStore({ initial, diagnostics })), warnings };
}

function listAt(s: HostState, pointer: string): readonly JsonValue[] {
  const value = s.getIn(pointer);
  if (!Array.isArray(value)) throw new Error(`expected an array at ${pointer}`);
  return value;
}

// Runs `fn` once, from inside the first store notification, so the writes inside it happen during delivery.
function duringDelivery(s: HostState, trigger: () => void, fn: () => void): void {
  let armed = true;
  s.subscribe(() => {
    if (!armed) return;
    armed = false;
    fn();
  });
  trigger();
}

describe('HostState reads and plain writes', () => {
  it('seed replaces the model from a validated spec.state and reads pointers', () => {
    const s = mk({});
    s.seed({ inputs: ['a.mp4'], codec: 'h264' });
    expect(s.getState()).toEqual({ inputs: ['a.mp4'], codec: 'h264' });
    expect(s.getIn('/codec')).toBe('h264');
    expect(s.getIn('/inputs/0')).toBe('a.mp4');
  });

  it('seed refuses a model that is not an object', () => {
    const s = mk({ keep: true });
    expect(() => s.seed(5)).toThrow();
    expect(() => s.seed(['a'])).toThrow();
    expect(s.getState()).toEqual({ keep: true });
  });

  it('setState writes a pointer immutably (new object identity)', () => {
    const s = mk({ codec: 'h264' });
    const before = s.getState();
    s.setState('/codec', 'h265');
    expect(s.getState()).toEqual({ codec: 'h265' });
    expect(s.getState()).not.toBe(before);
  });

  it('subscribe fires on every committed change and unsubscribes', () => {
    const s = mk({ n: 0 });
    let calls = 0;
    const off = s.subscribe(() => {
      calls += 1;
    });
    s.setState('/n', 1);
    expect(calls).toBe(1);
    off();
    s.setState('/n', 2);
    expect(calls).toBe(1);
  });

  it('a same-value write is suppressed: the whole document is compared, so subscribers fire once', () => {
    const s = mk({ codec: 'h264', list: [1, 2] });
    let calls = 0;
    s.subscribe(() => {
      calls += 1;
    });
    s.setState('/codec', 'h265');
    s.setState('/codec', 'h265');
    s.setState('/list', [1, 2]);
    expect(calls).toBe(1);
  });
});

describe('HostState pushState', () => {
  it('appends to the array at a pointer without mutating the previous state', () => {
    const s = mk({ inputs: ['a.mp4'] });
    const before = s.getState();
    s.pushState('/inputs', 'b.mp4');
    expect(listAt(s, '/inputs')).toEqual(['a.mp4', 'b.mp4']);
    expect(before).toEqual({ inputs: ['a.mp4'] });
  });

  it('starts a new array when the pointer holds nothing', () => {
    const s = mk({});
    s.pushState('/inputs', 'a.mp4');
    expect(listAt(s, '/inputs')).toEqual(['a.mp4']);
  });

  it('replaces a value that is not an array by a one-element array', () => {
    const s = mk({ inputs: 'a.mp4' });
    s.pushState('/inputs', 'b.mp4');
    expect(listAt(s, '/inputs')).toEqual(['b.mp4']);
  });

  it('escapes the segments of the pointer it appends to', () => {
    const s = mk({ 'a/b': [1], '': [2], 't~x': [3] });
    s.pushState('/a~1b', 9);
    s.pushState('/', 9);
    s.pushState('/t~0x', 9);
    expect(s.getState()).toEqual({ 'a/b': [1, 9], '': [2, 9], 't~x': [3, 9] });
  });

  it('two pushes from inside a store notification both land when the list exists', () => {
    const s = mk({ inputs: [], n: 0 });
    duringDelivery(
      s,
      () => s.setState('/n', 1),
      () => {
        s.pushState('/inputs', 'x');
        s.pushState('/inputs', 'y');
      },
    );
    expect(listAt(s, '/inputs')).toEqual(['x', 'y']);
  });

  it('known limit: the first push into a list that does not exist yet is lost when a second one follows in the same notification', () => {
    // The array-or-not decision is made on the committed read, and no patch operation appends or creates
    // against staged state, so both pushes take the create branch and the second replaces the first.
    const s = mk({ n: 0 });
    duringDelivery(
      s,
      () => s.setState('/n', 1),
      () => {
        s.pushState('/inputs', 'x');
        s.pushState('/inputs', 'y');
      },
    );
    expect(listAt(s, '/inputs')).toEqual(['y']);
  });
});

describe('HostState removeState', () => {
  it('removes BY INDEX from the array at a pointer', () => {
    const s = mk({ inputs: ['a.mp4', 'b.mp4', 'c.mp4'] });
    s.removeState('/inputs', 1);
    expect(listAt(s, '/inputs')).toEqual(['a.mp4', 'c.mp4']);
  });

  it('a non-array target is a no-op and logs nothing', () => {
    const { s, warnings } = mkLogged({ codec: 'h264' });
    s.removeState('/codec', 0);
    s.removeState('/missing', 0);
    expect(s.getState()).toEqual({ codec: 'h264' });
    expect(warnings).toEqual([]);
  });

  it('an index outside the array is a no-op and logs nothing', () => {
    const { s, warnings } = mkLogged({ inputs: ['a', 'b'] });
    s.removeState('/inputs', 2);
    s.removeState('/inputs', -1);
    s.removeState('/inputs', 1.5);
    expect(listAt(s, '/inputs')).toEqual(['a', 'b']);
    expect(warnings).toEqual([]);
  });

  it('two removes from inside a store notification both land', () => {
    const s = mk({ inputs: ['a', 'b', 'c', 'd'], n: 0 });
    duringDelivery(
      s,
      () => s.setState('/n', 1),
      () => {
        s.removeState('/inputs', 3);
        s.removeState('/inputs', 0);
      },
    );
    expect(listAt(s, '/inputs')).toEqual(['b', 'c']);
  });
});

describe('HostState applyStatePatch', () => {
  it('folds an RFC-6902 batch through the store', () => {
    const s = mk({ progress: 0 });
    s.applyStatePatch([{ op: 'replace', path: '/progress', value: 0.5 }]);
    expect(s.getIn('/progress')).toBe(0.5);
  });

  const ROOT_OPS: ReadonlyArray<readonly [string, JsonPatchOp]> = [
    ['remove the root', { op: 'remove', path: '' }],
    ['replace the root by a number', { op: 'replace', path: '', value: 5 }],
    ['replace the root by a list', { op: 'replace', path: '', value: [1] }],
    ['add a list at the root', { op: 'add', path: '', value: [1] }],
    ['move a member to the root', { op: 'move', from: '/s', path: '' }],
    ['copy a list to the root', { op: 'copy', from: '/arr', path: '' }],
  ];

  it.each(ROOT_OPS)('rejects a patch that would %s and leaves the store as it was', (_name, op) => {
    const s = mk({ s: 'text', arr: [1], safe: true });
    const before = s.getState();
    expect(() => s.applyStatePatch([op])).toThrow();
    expect(s.getState()).toBe(before);
  });

  it('a patch in the middle of a batch that fails changes nothing', () => {
    const s = mk({ a: 1 });
    const before = s.getState();
    expect(() =>
      s.applyStatePatch([
        { op: 'replace', path: '/a', value: 2 },
        { op: 'remove', path: '/missing' },
      ]),
    ).toThrow();
    expect(s.getState()).toBe(before);
  });

  it('agrees with fold-then-parse on a quiet store, for ordinary and root operations alike', () => {
    const base: JsonValue = { s: 'text', arr: [1, 2], o: { k: 1 } };
    const corpus: ReadonlyArray<readonly JsonPatchOp[]> = [
      [{ op: 'add', path: '/arr/-', value: 3 }],
      [{ op: 'replace', path: '/o/k', value: 2 }],
      [{ op: 'remove', path: '/s' }],
      [{ op: 'move', from: '/o', path: '/moved' }],
      [{ op: 'copy', from: '/arr', path: '/arr2' }],
      [{ op: 'test', path: '/s', value: 'text' }],
      [{ op: 'test', path: '/s', value: 'other' }],
      [{ op: 'remove', path: '/nope' }],
      ...ROOT_OPS.map(([, op]) => [op]),
      [
        { op: 'replace', path: '', value: { fresh: true } },
        { op: 'add', path: '/more', value: 1 },
      ],
    ];
    for (const patch of corpus) {
      const expected = (():
        | { readonly ok: true; readonly value: JsonValue }
        | { readonly ok: false } => {
        try {
          return { ok: true, value: JsonObjectSchema.parse(foldDelta(base, patch)) };
        } catch {
          return { ok: false };
        }
      })();
      const s = mk(base);
      if (!expected.ok) {
        expect(() => s.applyStatePatch(patch), JSON.stringify(patch)).toThrow();
        expect(s.getState()).toEqual(base);
      } else {
        s.applyStatePatch(patch);
        expect(s.getState(), JSON.stringify(patch)).toEqual(expected.value);
      }
    }
  });

  it('keeps an earlier write made inside the same store notification', () => {
    const s = mk({ n: 0 });
    duringDelivery(
      s,
      () => s.setState('/n', 1),
      () => {
        s.setState('/a', 1);
        s.applyStatePatch([{ op: 'add', path: '/b', value: 2 }]);
      },
    );
    expect(s.getState()).toEqual({ n: 1, a: 1, b: 2 });
  });

  it('refuses to move a member onto the root from inside a store notification and keeps an object root', () => {
    // After the staged write, the committed state still has /a as an object, so a check against the
    // committed state alone would let the move through and commit the number 5 as the whole document.
    const s = mk({ a: { k: 1 }, n: 0 });
    let thrown = false;
    duringDelivery(
      s,
      () => s.setState('/n', 1),
      () => {
        s.setState('/a', 5);
        try {
          s.applyStatePatch([{ op: 'move', from: '/a', path: '' }]);
        } catch {
          thrown = true;
        }
      },
    );
    expect(thrown).toBe(true);
    expect(s.getState()).toEqual({ a: 5, n: 1 });
  });
});
