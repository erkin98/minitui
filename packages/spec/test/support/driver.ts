import { videoMergeCatalog, type MinituiCatalog } from '@minitui/catalog';
import { composeValidation } from '../../src/loop.js';
import type { CapabilityProvider } from '../../src/capability-port.js';

// The canonical spec the rows share, as JSON text. With the shipped catalog and the capability provider
// below it is accepted with zero regenerations.
export const CANONICAL_TEXT = JSON.stringify({
  root: 'screen',
  elements: {
    screen: {
      type: 'Box',
      props: { flexDirection: 'column' },
      children: ['inputs', 'codec', 'merge', 'progress', 'status'],
    },
    inputs: { type: 'OrderList', props: { items: { $bindState: '/inputs' } } },
    codec: {
      type: 'Select',
      props: {
        label: 'Codec',
        value: { $state: '/codec' },
        options: [
          { label: 'H.264', value: 'h264' },
          { label: 'H.265', value: 'h265' },
          { label: 'VP9', value: 'vp9' },
        ],
      },
    },
    merge: {
      type: 'Button',
      props: { label: 'Merge' },
      on: {
        press: {
          action: 'merge',
          params: {
            inputs: { $state: '/inputs' },
            codec: { $state: '/codec' },
            output: { $state: '/output' },
          },
        },
      },
    },
    progress: { type: 'ProgressBar', props: { progress: { $state: '/merge/progress' } } },
    status: { type: 'Text', props: { text: { $state: '/merge/status' } } },
  },
  state: {
    inputs: ['a.mp4', 'b.mp4'],
    codec: 'h264',
    output: 'out.mp4',
    merge: { progress: 0, status: '' },
  },
});

export type Json = Record<string, unknown>;

export const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// A fresh parsed copy of the canonical spec to change as a plain object.
export function canonical(): Json {
  const parsed: unknown = JSON.parse(CANONICAL_TEXT);
  if (!isRecord(parsed)) throw new Error('canonical spec is not an object');
  return parsed;
}

// Set a value at a path inside a parsed spec. An undefined value removes the key.
export function setAt(root: Json, path: readonly string[], value: unknown): void {
  let cursor: unknown = root;
  for (const key of path.slice(0, -1)) {
    if (!isRecord(cursor)) throw new Error(`no object at ${key}`);
    cursor = cursor[key];
  }
  const last = path[path.length - 1];
  if (!isRecord(cursor) || last === undefined) throw new Error('bad path');
  if (value === undefined) delete cursor[last];
  else cursor[last] = value;
}

// The three patch lines a reply is made of; a missing part is not sent.
export function patchLines(spec: Json, omit: readonly string[] = []): string {
  return (
    ['root', 'elements', 'state']
      .filter((part) => !omit.includes(part) && part in spec)
      .map((part) => JSON.stringify({ op: 'add', path: `/${part}`, value: spec[part] }))
      .join('\n') + '\n'
  );
}

export async function* once(text: string): AsyncIterable<string> {
  yield text;
}

export const caps: CapabilityProvider = {
  listEncoders: async () => ['libx264'],
  listCodecs: async () => ['h264', 'h265', 'vp9'],
  listFilters: async () => ['scale'],
  statFile: async () => ({ exists: true, readable: true, isFile: true }),
};

export type Outcome = Awaited<ReturnType<typeof composeValidation>>;

export interface Drive {
  readonly result: Outcome | undefined;
  readonly thrown: unknown;
  readonly regenerations: number;
  readonly reprompts: readonly string[];
}

// Run the loop. `replies[0]` is the first stream; each regeneration gets the next reply, the last one
// repeating, so a single bad reply is sent on every pass.
export async function drive(args: {
  replies: readonly string[];
  catalog?: MinituiCatalog;
  capabilities?: CapabilityProvider;
  streams?: readonly AsyncIterable<string>[];
}): Promise<Drive> {
  const reprompts: string[] = [];
  const first = args.streams?.[0] ?? once(args.replies[0] ?? '');
  try {
    const result = await composeValidation({
      stream: first,
      catalog: args.catalog ?? videoMergeCatalog,
      capabilities: args.capabilities ?? caps,
      regenerate: (reprompt) => {
        reprompts.push(reprompt);
        const streamed = args.streams?.[reprompts.length];
        if (streamed !== undefined) return streamed;
        const reply = args.replies[Math.min(reprompts.length, args.replies.length - 1)] ?? '';
        return once(reply);
      },
    });
    return { result, thrown: undefined, regenerations: reprompts.length, reprompts };
  } catch (thrown) {
    return { result: undefined, thrown, regenerations: reprompts.length, reprompts };
  }
}

export const good = (): string => patchLines(canonical());

export function lastEnvelope(run: Drive) {
  if (run.result === undefined || run.result.ok) throw new Error('expected a give-up result');
  return run.result.lastEnvelope;
}

// Add an element and list it as the last child of `parent`.
export function addChild(spec: Json, parent: string, key: string, element: unknown): void {
  setAt(spec, ['elements', key], element);
  const owner = isRecord(spec.elements) ? spec.elements[parent] : undefined;
  if (!isRecord(owner) || !Array.isArray(owner.children)) throw new Error('bad fixture');
  owner.children.push(key);
}
