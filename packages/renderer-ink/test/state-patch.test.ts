import { describe, expect, it } from 'vitest';
import {
  assertJsonResourceBudget,
  JsonObjectSchema,
  type AppSpec,
  type JsonPatch,
  type JsonValue,
} from '@minitui/types';
import { mountInk } from '../src/mount.js';
import { applyEngineOperation, applyStatePatchTo } from '../src/state-patch.js';
import { createInkBinding } from '../src/widgets/bindings.js';
import { makeCatalog } from './support/make-catalog.js';
import { controlledIo } from './support/store-io.js';
import { makeController } from './support/controllers.js';
import { FakeStdin, FakeStdout, asReadStream, asWriteStream } from './support/fake-streams.js';

const catalog = makeCatalog({ id: 'patch', components: { Text: { trustTier: 'display' } } });
const spec: AppSpec = { root: 't', elements: { t: { type: 'Text', props: { text: 'x' } } } };

function mount(seed: Record<string, unknown>) {
  const io = controlledIo(seed);
  const handle = mountInk({
    spec,
    catalog,
    binding: createInkBinding(catalog),
    dispatcher: { dispatch: async () => ({ status: 'settled' as const }) },
    store: io,
    consent: makeController([]),
    io: {
      stdin: asReadStream(new FakeStdin()),
      stdout: asWriteStream(new FakeStdout()),
      debug: true,
    },
  });
  return { io, handle };
}

// a C0, DEL or C1 control character
const hasControl = (text: string): boolean =>
  [...text].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
const ESC = String.fromCharCode(27);
// a token of a megabyte: canonical text, so only the message can carry it
const LONG = 'q'.repeat(1_000_000);

function thrown(run: () => void): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error('the patch did not throw');
}

const seed = { list: ['a', 'b'], obj: { k: 1 }, prim: 5 };

describe('the messages of the state patch are fixed strings', () => {
  const cases: Array<[string, JsonPatch, string]> = [
    [
      'a pointer without a leading slash',
      { op: 'remove', path: 'x' + LONG },
      'invalid JSON pointer',
    ],
    [
      'a pointer token with an escape',
      { op: 'add', path: `/${ESC}k`, value: 1 },
      'state key is not canonical',
    ],
    [
      'a value key with an escape',
      { op: 'add', path: '/n', value: { [ESC]: 1 } },
      'state key is not canonical',
    ],
    [
      'a non-index token inside an array path',
      { op: 'replace', path: `/list/${LONG}/x`, value: 1 },
      'invalid array index',
    ],
    [
      'an array member past the end inside a path',
      { op: 'replace', path: '/list/99/x', value: 1 },
      'array member does not exist',
    ],
    [
      'an object member that is missing inside a path',
      { op: 'replace', path: `/obj/${LONG}/x`, value: 1 },
      'object member does not exist',
    ],
    [
      'an add with a non-index array token',
      { op: 'add', path: `/list/${LONG}`, value: 1 },
      'invalid add array index',
    ],
    [
      'a replace with a non-index array token',
      { op: 'replace', path: `/list/${LONG}`, value: 1 },
      'invalid array index',
    ],
    [
      'a remove with a non-index array token',
      { op: 'remove', path: `/list/${LONG}` },
      'invalid array index',
    ],
    [
      'a test with a non-index array token',
      { op: 'test', path: `/list/${LONG}`, value: 1 },
      'invalid array index',
    ],
    [
      'a replace of an array member past the end',
      { op: 'replace', path: '/list/9', value: 1 },
      'array member does not exist',
    ],
    [
      'a remove of an array member past the end',
      { op: 'remove', path: '/list/9' },
      'array member does not exist',
    ],
    [
      'a test of an array member past the end',
      { op: 'test', path: '/list/9', value: 1 },
      'array member does not exist',
    ],
    [
      'a replace of a missing object member',
      { op: 'replace', path: `/obj/${LONG}`, value: 1 },
      'object member does not exist',
    ],
    [
      'a remove of a missing object member',
      { op: 'remove', path: `/obj/${LONG}` },
      'object member does not exist',
    ],
    [
      'a test of a missing object member',
      { op: 'test', path: `/obj/${LONG}`, value: 1 },
      'object member does not exist',
    ],
  ];

  it.each(cases)('%s', (_name, operation, fixed) => {
    const { io, handle } = mount(seed);
    const before = JSON.stringify(io.getSnapshot());
    const error = thrown(() => handle.applyStatePatch([operation]));
    expect(error.message).toBe(fixed);
    expect(error.message.length).toBeLessThanOrEqual(80);
    expect(hasControl(error.message)).toBe(false);
    expect(JSON.stringify(io.getSnapshot())).toBe(before);
    handle.unmount();
  });
});

describe('errors of the patch engine', () => {
  it('a failed test names its index and holds none of the document', () => {
    const { handle } = mount({ secret: 'SENTINEL-VALUE', n: 1 });
    const error = thrown(() =>
      handle.applyStatePatch([
        { op: 'add', path: '/n', value: 2 },
        { op: 'test', path: '/secret', value: 'something else' },
      ]),
    );
    expect(error.message).toBe('invalid state delta: test operation failed');
    expect((error as { opIndex?: unknown }).opIndex).toBe(1);
    expect(error.message).not.toContain('SENTINEL-VALUE');
    handle.unmount();
  });

  it('an operation the engine rejects throws the fixed engine message with its index', () => {
    const error = thrown(() =>
      applyEngineOperation({ a: 1 }, { op: 'remove', path: '/missing' }, 3),
    );
    expect(error.message).toBe('invalid state delta: patch engine rejected the operation');
    expect((error as { opIndex?: unknown }).opIndex).toBe(3);
  });
});

describe('the cost of a patch of moves', () => {
  const MOVES = 64;
  // The cost of a patch of moves is bounded against the unavoidable work of the same patch, not against
  // the clock. The patch path walks the whole document once per operation (the resource budget) and parses
  // it twice per patch (the snapshot in, the result out), so a correct patch of 64 moves costs about 64
  // walks plus two parses. The defect this row guards, a clone and a parse of the whole document for each
  // move, adds about 49 walks per move. The row times the patch and, in the same process, that reference
  // work on a document of the same shape (64 walks and two parses), in up to five interleaved pairs with
  // the order alternating, and takes the least ratio. A busy machine and v8 coverage stretch both sides
  // alike: the ratio of a correct patch read at most 1.05 in 120 readings (with and without coverage,
  // quiet and beside 14 and 32 busy loops), the old clone and parse read at least 7.2 in 28 readings in
  // the same conditions, and the bound of 2.75 is about 2.6 times from each. It catches extra
  // whole-document work of about five to eight walks per move, not a clone alone; a slowdown of the walk
  // or the parse themselves cancels against the reference. An absolute bound of 3,000 ms failed 6 of 9
  // runs of the hook's coverage step: the patch takes 0.25 s alone, about three times that under
  // coverage and three to five times that on a saturated machine.
  const BOUND = 2.75;
  const buildDoc = (): Record<string, JsonValue> => {
    const doc: Record<string, JsonValue> = { big: Array.from({ length: 64_000 }, (_, i) => i) };
    for (let i = 0; i < MOVES; i++) doc[`a${i}`] = 0;
    return doc;
  };
  const timed = (run: () => void): number => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };
  const referenceWork = (doc: JsonValue): void => {
    for (let i = 0; i < MOVES; i++) assertJsonResourceBudget(doc);
    JsonObjectSchema.parse(doc);
    JsonObjectSchema.parse(doc);
  };
  // one pair: the patch on a fresh document and the reference work on a second one, built outside the
  // timed regions; the order alternates so that neither side always runs on the other's garbage
  const ratioOf = (order: number): number => {
    const io = controlledIo(buildDoc());
    const reference = buildDoc();
    const moves: JsonPatch[] = Array.from({ length: MOVES }, (_, i) => ({
      op: 'move',
      from: `/a${i}`,
      path: `/b${i}`,
    }));
    let patchMs = 0;
    let referenceMs = 0;
    if (order % 2 === 0) {
      patchMs = timed(() => applyStatePatchTo(io, moves));
      referenceMs = timed(() => referenceWork(reference));
    } else {
      referenceMs = timed(() => referenceWork(reference));
      patchMs = timed(() => applyStatePatchTo(io, moves));
    }
    // a patch that did nothing would be fast: the moves must have happened and nothing else changed
    const after = io.getSnapshot();
    const keys = Object.keys(after);
    expect(keys.filter((key) => /^a\d+$/.test(key))).toHaveLength(0);
    expect(keys.filter((key) => /^b\d+$/.test(key))).toHaveLength(MOVES);
    expect(Array.isArray(after.big) ? after.big.length : -1).toBe(64_000);
    return patchMs / referenceMs;
  };

  it('64 moves on a document of 64,001 nodes finish within the bound', () => {
    ratioOf(1); // warm-up, not counted
    let least = Infinity;
    // the verdict "least of five pairs under the bound" is "some pair under the bound": stop at the first
    for (let k = 0; k < 5 && least >= BOUND; k++) least = Math.min(least, ratioOf(k));
    expect(least, 'least ratio of the patch to its reference work').toBeLessThan(BOUND);
  }, 120_000);
});

describe('the message of a reserved key', () => {
  it('names no key', () => {
    const { handle } = mount({});
    const refused: JsonPatch[][] = [
      [{ op: 'add', path: '/__proto__/x', value: 1 }],
      [{ op: 'add', path: '/a/constructor', value: 1 }],
    ];
    for (const patch of refused) {
      expect(() => handle.applyStatePatch(patch)).toThrow(/^reserved state key not allowed$/);
    }
    handle.unmount();
  });
});
