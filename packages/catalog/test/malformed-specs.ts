import { z } from 'zod';
import { defineMinituiCatalog, type MinituiCatalog } from '../src/define-catalog.js';

// Test support shared by the three gate entry points: a small real catalog and the malformed specs
// every entry point must answer with an issue instead of a throw. Each row names the code it must
// produce, so a catch-all that returns some other issue does not satisfy it.
export const gateCatalog: MinituiCatalog = defineMinituiCatalog({
  id: 'demo',
  components: {
    Box: {
      props: z.object({}).strict(),
      slots: ['default'],
      description: 'box',
      trustTier: 'display',
    },
    Button: {
      props: z.object({ label: z.string() }).strict(),
      slots: [],
      description: 'btn',
      trustTier: 'interactive',
    },
  },
  actions: {
    merge: {
      params: z.object({}),
      description: 'merge',
      kind: 'exec-local',
      permission: { danger: true, resourceTemplate: 'ffmpeg', summaryTemplate: 'Merge' },
    },
    setState: {
      params: z.object({ statePath: z.string(), value: z.unknown() }),
      description: 'set',
      kind: 'render-local',
    },
  },
});

export type MalformedRow = readonly [
  name: string,
  build: () => unknown,
  code: 'malformed-spec' | 'malformed-binding' | 'non-canonical-key',
  messagePart?: string,
];

function nest(depth: number): unknown {
  let value: unknown = 0;
  for (let i = 0; i < depth; i++) value = { a: value };
  return value;
}

// level N holds level N-1 twice: the same object in two places
function sharedGraph(levels: number): unknown {
  let level: unknown = { leaf: 1 };
  for (let i = 0; i < levels; i++) level = { a: level, b: level };
  return level;
}

const ESC = '\u001b';

const spec = (elements: unknown): unknown => ({ root: 'a', elements });
const withElement = (element: unknown): unknown => spec({ a: element });
const box = (extra: object): unknown => withElement({ type: 'Box', props: {}, ...extra });
const bound = (binding: unknown): unknown =>
  withElement({ type: 'Box', props: {}, on: { press: binding } });

function cyclic(): unknown {
  const props: Record<string, unknown> = {};
  props.self = props;
  return withElement({ type: 'Box', props });
}

export const MALFORMED_ROWS: readonly MalformedRow[] = [
  ['a cyclic value', cyclic, 'malformed-spec'],
  [
    'a value nested 3000 deep',
    () => withElement({ type: 'Box', props: { deep: nest(3000) } }),
    'malformed-spec',
  ],
  [
    'a shared-reference graph 16 levels deep',
    () => withElement({ type: 'Box', props: { graph: sharedGraph(16) } }),
    'malformed-spec',
  ],
  ['an element with no props', () => withElement({ type: 'Box' }), 'malformed-spec'],
  ['props that is null', () => withElement({ type: 'Box', props: null }), 'malformed-spec'],
  ['props that is an array', () => withElement({ type: 'Box', props: [] }), 'malformed-spec'],
  ['props that is a number', () => withElement({ type: 'Box', props: 5 }), 'malformed-spec'],
  ['a type that is an object', () => withElement({ type: { a: 1 }, props: {} }), 'malformed-spec'],
  ['an element that is null', () => withElement(null), 'malformed-spec'],
  ['elements missing', () => ({ root: 'a' }), 'malformed-spec'],
  ['elements that is null', () => spec(null), 'malformed-spec'],
  ['elements that is an array', () => spec([]), 'malformed-spec'],
  ['elements that is a number', () => spec(5), 'malformed-spec'],
  [
    'an action shaped like { toString: 0 }',
    () => bound({ action: { toString: 0 } }),
    'malformed-binding',
  ],
  ['an action that is a plain object', () => bound({ action: {} }), 'malformed-binding'],
  [
    'on that is a string',
    () => box({ on: 'press' }),
    'malformed-binding',
    'is not an object of bindings',
  ],
  ['on that is null', () => box({ on: null }), 'malformed-binding'],
  [
    'watch that is a string',
    () => box({ watch: '/x' }),
    'malformed-binding',
    'is not an object of bindings',
  ],
  ['watch that is null', () => box({ watch: null }), 'malformed-binding'],
  ['params that is a string', () => bound({ action: 'merge', params: 'x' }), 'malformed-binding'],
  ['params that is an array', () => bound({ action: 'merge', params: [] }), 'malformed-binding'],
  [
    'an escape byte before $computed in a param key',
    () => bound({ action: 'setState', params: { [`${ESC}$computed`]: 1 } }),
    'non-canonical-key',
  ],
  [
    'an escape byte before on',
    () => box({ [`${ESC}on`]: { press: { action: 'merge' } } }),
    'non-canonical-key',
  ],
  [
    'an escape byte before onSuccess on a binding',
    () => bound({ action: 'merge', [`${ESC}onSuccess`]: {} }),
    'non-canonical-key',
  ],
  [
    'an escape byte before a prop key',
    () => withElement({ type: 'Box', props: { [`${ESC}width`]: 1 } }),
    'non-canonical-key',
  ],
  [
    'two element keys that collide after sanitising',
    () => spec({ a: { type: 'Box', props: {} }, [`a${ESC}`]: { type: 'Box', props: {} } }),
    'non-canonical-key',
  ],
  [
    'a C1 control inside an event name',
    () => box({ on: { 'pr\u0085ess': { action: 'merge' } } }),
    'non-canonical-key',
  ],
  [
    'a reserved event name built with JSON.parse',
    () => box({ on: JSON.parse('{"__proto__":{"action":"merge"}}') }),
    'malformed-spec',
  ],
];

export const MALFORMED_CASES = MALFORMED_ROWS.map(([name, build, code, messagePart]) => ({
  name,
  build,
  code,
  messagePart,
}));

// Element keys outside ASCII are ordinary names, not a reason to refuse a spec.
export const unicodeKeySpec: unknown = {
  root: 'Да',
  elements: {
    Да: { type: 'Box', props: {}, children: ['漢字'] },
    漢字: { type: 'Button', props: { label: 'Go' }, on: { press: { action: 'merge' } } },
  },
};

export const cleanSpec: unknown = withElement({
  type: 'Button',
  props: { label: 'Go' },
  on: { press: { action: 'merge' } },
});
