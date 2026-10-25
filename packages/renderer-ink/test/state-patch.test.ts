import { describe, expect, it } from 'vitest';
import type { AppSpec, JsonPatch } from '@minitui/types';
import { mountInk } from '../src/mount.js';
import { applyEngineOperation } from '../src/state-patch.js';
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
  it('64 moves on a document of 64,001 nodes finish within the bound', () => {
    const doc: Record<string, unknown> = { big: Array.from({ length: 64_000 }, (_, i) => i) };
    for (let i = 0; i < 64; i++) doc[`a${i}`] = 0;
    const { handle } = mount(doc);
    const moves: JsonPatch[] = Array.from({ length: 64 }, (_, i) => ({
      op: 'move',
      from: `/a${i}`,
      path: `/b${i}`,
    }));
    const started = performance.now();
    handle.applyStatePatch(moves);
    const elapsed = performance.now() - started;
    // measured on this machine: about 6.2 s with a clone and a parse of the document per move,
    // about 0.4 s without
    expect(elapsed).toBeLessThan(3000);
    handle.unmount();
  });
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
