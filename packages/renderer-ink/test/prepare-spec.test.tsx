import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AppSpec } from '@minitui/types';
import { MAX_ELEMENT_DEPTH } from '@minitui/catalog';
import { mountInk } from '../src/mount.js';
import { createInkBinding } from '../src/widgets/bindings.js';
import { makeCatalog } from './support/make-catalog.js';
import { controlledIo } from './support/store-io.js';
import { makeController } from './support/controllers.js';
import { FakeStdin, FakeStdout, asReadStream, asWriteStream } from './support/fake-streams.js';
import { afterEffects, until } from './support/focus-waits.js';

const catalog = makeCatalog({
  id: 'prepare',
  components: {
    Box: { trustTier: 'display' },
    Text: { trustTier: 'display' },
    Button: { trustTier: 'interactive' },
  },
  actions: {
    setState: { kind: 'render-local', params: z.object({}) },
    merge: {
      kind: 'exec-local',
      params: z.object({}),
      permission: { danger: false, resourceTemplate: 'merge', summaryTemplate: 'merge' },
    },
  },
});

function mountSpec(spec: AppSpec) {
  const stdout = new FakeStdout();
  const handle = mountInk({
    spec,
    catalog,
    binding: createInkBinding(catalog),
    dispatcher: { dispatch: async () => ({ status: 'settled' as const }) },
    store: controlledIo({}),
    consent: makeController([]),
    io: {
      stdin: asReadStream(new FakeStdin()),
      stdout: asWriteStream(stdout),
      debug: true,
    },
  });
  return { handle, last: () => stdout.frames.at(-1) ?? '', stdout };
}

const leaf: AppSpec = {
  root: 'leaf',
  elements: { leaf: { type: 'Text', props: { text: 'a safe leaf' } } },
};

// the error a refusal throws: an Error with a code
function codeOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function refusal(run: () => unknown): { code: string | undefined; message: string } {
  try {
    run();
  } catch (error) {
    return { code: codeOf(error), message: error instanceof Error ? error.message : '' };
  }
  return { code: undefined, message: '' };
}

// a chain of Box elements: e0 is the root, each lists the next, the last holds a text leaf
function chain(levels: number): AppSpec {
  const elements: Record<string, AppSpec['elements'][string]> = {};
  for (let i = 0; i < levels - 1; i++) {
    elements[`e${i}`] = { type: 'Box', props: {}, children: [`e${i + 1}`] };
  }
  elements[`e${levels - 1}`] = { type: 'Text', props: { text: 'the leaf of the chain' } };
  return { root: 'e0', elements };
}

const twice: AppSpec = {
  root: 'root',
  elements: {
    root: { type: 'Box', props: {}, children: ['a', 'a'] },
    a: { type: 'Text', props: { text: 'listed twice' } },
  },
};
const noRoot: AppSpec = {
  root: 'missing',
  elements: { a: { type: 'Text', props: { text: 'x' } } },
};
const inheritedRoot: AppSpec = {
  root: 'constructor',
  elements: { a: { type: 'Text', props: { text: 'x' } } },
};

describe('the tree guard at mount and at update', () => {
  const refused: Array<[string, AppSpec]> = [
    ['a child listed twice', twice],
    [`a chain of ${MAX_ELEMENT_DEPTH + 1} levels`, chain(MAX_ELEMENT_DEPTH + 1)],
    ['a root that names no element', noRoot],
    ['a root named constructor with no such element', inheritedRoot],
  ];

  it.each(refused)('%s is refused at mount with code not-a-tree', (_name, spec) => {
    const result = refusal(() => mountSpec(spec));
    expect(result.code).toBe('not-a-tree');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it.each(refused)('%s is refused at update with code not-a-tree', (_name, spec) => {
    const { handle } = mountSpec(leaf);
    expect(refusal(() => handle.update(spec)).code).toBe('not-a-tree');
    handle.unmount();
  });

  it(`control: a chain of ${MAX_ELEMENT_DEPTH} levels mounts and updates`, async () => {
    const { handle, last } = mountSpec(chain(MAX_ELEMENT_DEPTH));
    await until(() => last().includes('the leaf of the chain'), 'the leaf of the chain');
    handle.update(leaf);
    await until(() => last().includes('a safe leaf'), 'the update');
    await afterEffects();
    handle.unmount();
  });

  it('values that share references to 24 levels are refused fast, as a non-canonical key', () => {
    let shared: Record<string, unknown> = { text: 'x' };
    for (let level = 0; level < 24; level++) shared = { left: shared, right: shared };
    const spec: AppSpec = {
      root: 'a',
      elements: { a: { type: 'Text', props: { text: 'x', deep: shared } as never } },
    };
    const started = performance.now();
    const result = refusal(() => mountSpec(spec));
    const elapsed = performance.now() - started;
    expect(result.code).toBe('non-canonical-key');
    // the sanitiser alone needs about 1.2 s at 20 levels of sharing and several seconds at 24; the
    // key predicate rejects in about a millisecond
    expect(elapsed).toBeLessThan(500);
  });
});

const ESC = String.fromCharCode(27);
const specOf = (text: string): AppSpec => {
  const built: AppSpec = JSON.parse(text);
  return built;
};

describe('keys that sanitising would change are refused before any render', () => {
  it('an event key that starts with an escape is refused at mount', () => {
    const spec = specOf(
      JSON.stringify({
        root: 'b',
        elements: {
          b: {
            type: 'Button',
            props: { label: 'go' },
            on: { [ESC + 'press']: { action: 'merge', params: {} } },
          },
        },
      }),
    );
    expect(refusal(() => mountSpec(spec)).code).toBe('non-canonical-key');
  });

  it('a params key with an escape before a marker key is refused at mount and at update', () => {
    const spec = specOf(
      JSON.stringify({
        root: 'b',
        elements: {
          b: {
            type: 'Button',
            props: { label: 'go' },
            on: { press: { action: 'merge', params: { [ESC + '$computed']: 'x' } } },
          },
        },
      }),
    );
    expect(refusal(() => mountSpec(spec)).code).toBe('non-canonical-key');
    const { handle } = mountSpec(leaf);
    expect(refusal(() => handle.update(spec)).code).toBe('non-canonical-key');
    handle.unmount();
  });
});

describe('the prepared binding', () => {
  const written = (binding: string) =>
    specOf(
      `{"root":"b","elements":{"b":{"type":"Button","props":{"label":"go"},"on":{"press":${binding}}}}}`,
    );
  const hostile =
    '{"action":"merge","params":{"n":1},"preventDefault":true,"unknownKey":1,"confirm":{"title":"t"},"onSuccess":{"set":{}},"onError":{"set":{}}}';

  it('a single binding has exactly the own keys action and params', () => {
    const { handle } = mountSpec(written(hostile));
    const press = handle.activeSpec.elements.b?.on?.press;
    const one = Array.isArray(press) ? press[0] : press;
    expect(Object.keys(one ?? {}).sort()).toEqual(['action', 'params']);
    handle.unmount();
  });

  it('every binding of a list has exactly the own keys action and params', () => {
    const { handle } = mountSpec(written(`[${hostile},${hostile}]`));
    const press = handle.activeSpec.elements.b?.on?.press;
    const list = Array.isArray(press) ? press : [];
    expect(list).toHaveLength(2);
    for (const one of list) expect(Object.keys(one).sort()).toEqual(['action', 'params']);
    handle.unmount();
  });
});

describe('watch is not supported', () => {
  const watching = specOf(
    '{"root":"a","elements":{"a":{"type":"Text","props":{"text":"x"},"watch":{"/x":{"action":"setState","params":{}}}}}}',
  );

  it('an element with a watch map is refused at mount', () => {
    expect(refusal(() => mountSpec(watching)).code).toBe('watch-unsupported');
  });

  it('an element with a watch map is refused at update', () => {
    const { handle } = mountSpec(leaf);
    expect(refusal(() => handle.update(watching)).code).toBe('watch-unsupported');
    handle.unmount();
  });
});

describe('the canonical-key checks of the state patch stay in force', () => {
  function patching() {
    const io = controlledIo({ a: { b: 1 }, list: [1, 2] });
    const handle = mountInk({
      spec: leaf,
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
  const dirtyToken = `/${ESC}x`;

  // operations whose token never lands in the document: without the check they fail for another
  // reason (a missing member), so the message is what shows the check ran
  it.each([
    ['remove', { op: 'remove', path: dirtyToken }],
    ['test', { op: 'test', path: dirtyToken, value: 1 }],
    ['copy source', { op: 'copy', from: dirtyToken, path: '/c' }],
    ['move source', { op: 'move', from: dirtyToken, path: '/c' }],
  ])('a token with an escape in a %s operation is refused', (_name, operation) => {
    const { io, handle } = patching();
    const before = JSON.stringify(io.getSnapshot());
    let message = '';
    try {
      handle.applyStatePatch([JSON.parse(JSON.stringify(operation))]);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toMatch(/not canonical/);
    expect(JSON.stringify(io.getSnapshot())).toBe(before);
    handle.unmount();
  });

  it('an add whose object value has an escape-keyed member is refused and the state is unchanged', () => {
    const { io, handle } = patching();
    const before = JSON.stringify(io.getSnapshot());
    const value: Record<string, number> = { [ESC + 'k']: 1 };
    let message = '';
    try {
      handle.applyStatePatch([{ op: 'add', path: '/fresh', value }]);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toMatch(/not canonical/);
    expect(JSON.stringify(io.getSnapshot())).toBe(before);
    handle.unmount();
  });
});
