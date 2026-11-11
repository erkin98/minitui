import { describe, it, expect } from 'vitest';
import { videoMergeCatalog } from '@minitui/catalog';
import type { CapabilityProvider } from '../src/capability-port.js';
import {
  caps,
  canonical,
  drive,
  good,
  isRecord,
  lastEnvelope,
  patchLines,
  setAt,
  type Json,
} from './support/driver.js';

// Every pass gets the same bad reply, so the give-up envelope is the envelope of that reply.
async function envelopeOf(spec: Json) {
  const run = await drive({ replies: [patchLines(spec)] });
  expect(run.regenerations).toBe(5);
  return lastEnvelope(run);
}

// One regeneration is enough when the second reply is the valid spec.
async function oneRegeneration(spec: Json) {
  const run = await drive({ replies: [patchLines(spec), good()] });
  expect(run.result?.ok).toBe(true);
  expect(run.regenerations).toBe(1);
  return run;
}

function expectWireEnvelope(env: Awaited<ReturnType<typeof envelopeOf>>, line: string): void {
  expect(env.catalog).toEqual([]);
  expect(env.semantic).toEqual([]);
  expect(env.structural.length).toBeGreaterThan(0);
  for (const issue of env.structural) expect(issue.code).toBe('empty_spec');
  expect(env.structural.map((i) => i.message)).toContain(line);
}

const wire: Array<[string, (spec: Json) => void, string]> = [
  [
    'an element with no props',
    (s) => setAt(s, ['elements', 'screen', 'props'], undefined),
    'elements/screen/props: wrong shape for this field',
  ],
  [
    'props that are null',
    (s) => setAt(s, ['elements', 'screen', 'props'], null),
    'elements/screen/props: wrong shape for this field',
  ],
  [
    'props that are an array',
    (s) => setAt(s, ['elements', 'screen', 'props'], []),
    'elements/screen/props: wrong shape for this field',
  ],
  [
    'children that are an object',
    (s) => setAt(s, ['elements', 'screen', 'children'], {}),
    'elements/screen/children: wrong shape for this field',
  ],
  [
    'children that are a string',
    (s) => setAt(s, ['elements', 'screen', 'children'], 'ab'),
    'elements/screen/children: wrong shape for this field',
  ],
  [
    'children that are the empty string',
    (s) => setAt(s, ['elements', 'screen', 'children'], ''),
    'elements/screen/children: wrong shape for this field',
  ],
  [
    'a repeat statePath that is a number',
    (s) => setAt(s, ['elements', 'progress', 'repeat'], { statePath: 5 }),
    'elements/progress/repeat/statePath: wrong shape for this field',
  ],
  [
    'a repeat key that is a number',
    (s) => setAt(s, ['elements', 'progress', 'repeat'], { statePath: '/inputs', key: 5 }),
    'elements/progress/repeat/key: wrong shape for this field',
  ],
  [
    'a binding with an extra key',
    (s) => setAt(s, ['elements', 'merge', 'on', 'press', 'description'], 'x'),
    'elements/merge/on/press: unexpected key "description"',
  ],
  [
    'a binding with onSuccess',
    (s) => setAt(s, ['elements', 'merge', 'on', 'press', 'onSuccess'], { action: 'merge' }),
    'elements/merge/on/press: unexpected key "onSuccess"',
  ],
  [
    'a binding with confirm',
    (s) => setAt(s, ['elements', 'merge', 'on', 'press', 'confirm'], {}),
    'elements/merge/on/press: unexpected key "confirm"',
  ],
  [
    'a binding with an equal callableFrom',
    (s) => setAt(s, ['elements', 'merge', 'on', 'press', 'callableFrom'], 'clientOnly'),
    'elements/merge/on/press: unexpected key "callableFrom"',
  ],
  [
    'a binding with a narrower callableFrom',
    (s) => setAt(s, ['elements', 'merge', 'on', 'press', 'callableFrom'], 'localOnly'),
    'elements/merge/on/press: unexpected key "callableFrom"',
  ],
  [
    'binding params that are an array',
    (s) => setAt(s, ['elements', 'merge', 'on', 'press', 'params'], []),
    'elements/merge/on/press/params: wrong shape for this field',
  ],
  [
    'on that is a string',
    (s) => setAt(s, ['elements', 'screen', 'on'], 'press'),
    'elements/screen/on: wrong shape for this field',
  ],
  [
    'watch that is a number',
    (s) => setAt(s, ['elements', 'screen', 'watch'], 5),
    'elements/screen/watch: wrong shape for this field',
  ],
  ['a root that is a number', (s) => setAt(s, ['root'], 5), 'root: wrong shape for this field'],
];

describe('the wire schema gates the loop and the envelope names the failing path', () => {
  it.each(wire)('%s', async (_name, change, line) => {
    const spec = canonical();
    change(spec);
    expectWireEnvelope(await envelopeOf(spec), line);
    const run = await oneRegeneration(spec);
    expect(run.reprompts[0]).toContain(line);
  });

  it('the line holds none of the library wording', async () => {
    const spec = canonical();
    setAt(spec, ['elements', 'merge', 'on', 'press', 'onSuccess'], { action: 'merge' });
    const env = await envelopeOf(spec);
    for (const issue of env.structural) {
      expect(issue.message).not.toMatch(/Invalid input|Unrecognized key|\bexpected\b|\breceived\b/);
    }
  });
});

describe('the auto-fixed value is what the wire parse reads', () => {
  it('an on placed inside props is relocated first, so the binding is judged in its final place', async () => {
    const spec = canonical();
    setAt(spec, ['elements', 'merge', 'props', 'on'], {
      press: { action: 'merge', params: {}, extra: 1 },
    });
    setAt(spec, ['elements', 'merge', 'on'], undefined);
    const env = await envelopeOf(spec);
    expect(env.structural.map((i) => i.message)).toContain(
      'elements/merge/on/press: unexpected key "extra"',
    );
    expect(env.catalog).toEqual([]);
  });
});

describe('a validator fault is a repair attempt and never a throw', () => {
  it('a null element faults auto-fix: the contained-fault envelope, one regeneration', async () => {
    const spec = canonical();
    setAt(spec, ['elements', 'ghost'], null);
    const env = await envelopeOf(spec);
    expect(env.structural).toHaveLength(1);
    expect(env.structural[0]?.code).toBe('empty_spec');
    expect(env.catalog).toEqual([]);
    expect(env.semantic).toEqual([]);
    await oneRegeneration(spec);
  });

  it('a catalog method that throws gives the fixed message and none of the thrown text', async () => {
    const catalog = {
      ...videoMergeCatalog,
      visibilityOf: (): never => {
        throw new Error('SECRET-FAULT-TEXT');
      },
    };
    const run = await drive({ replies: [good()], catalog });
    const env = lastEnvelope(run);
    expect(run.regenerations).toBe(5);
    expect(env.structural).toHaveLength(1);
    expect(env.structural[0]?.code).toBe('empty_spec');
    expect(JSON.stringify(env)).not.toContain('SECRET-FAULT-TEXT');
    for (const reprompt of run.reprompts) expect(reprompt).not.toContain('SECRET-FAULT-TEXT');
  });
});

describe('a failed host capability is not a bad generation', () => {
  const fault = new Error('capability port down');
  const reject = async (): Promise<never> => {
    throw fault;
  };
  const sync = (): never => {
    throw fault;
  };
  const ports: Array<[string, CapabilityProvider]> = [
    ['listEncoders rejecting', { ...caps, listEncoders: reject }],
    ['listCodecs rejecting', { ...caps, listCodecs: reject }],
    ['listFilters rejecting', { ...caps, listFilters: reject }],
    ['listEncoders throwing synchronously', { ...caps, listEncoders: sync }],
    ['listCodecs throwing synchronously', { ...caps, listCodecs: sync }],
  ];
  it.each(ports)(
    '%s: the same object leaves the loop, with no regeneration',
    async (_name, capabilities) => {
      const run = await drive({ replies: [good()], capabilities });
      expect(run.thrown).toBe(fault);
      expect(run.regenerations).toBe(0);
    },
  );

  it('statFile rejecting, with a picker whose path is reached', async () => {
    const spec = canonical();
    setAt(spec, ['elements', 'pick'], {
      type: 'FilePicker',
      props: { label: 'in', value: 'a.mp4' },
    });
    const children = isRecord(spec.elements) ? spec.elements.screen : undefined;
    if (!isRecord(children) || !Array.isArray(children.children)) throw new Error('bad fixture');
    children.children.push('pick');
    const capabilities: CapabilityProvider = { ...caps, statFile: reject };
    const run = await drive({ replies: [patchLines(spec)], capabilities });
    expect(run.thrown).toBe(fault);
    expect(run.regenerations).toBe(0);
  });
});

describe('controls', () => {
  it('the canonical spec is accepted with zero regenerations', async () => {
    const run = await drive({ replies: [good()] });
    expect(run.result?.ok).toBe(true);
    expect(run.regenerations).toBe(0);
  });

  it('an element-level key the wire schema does not model is kept, and is not frozen', async () => {
    const spec = canonical();
    setAt(spec, ['elements', 'status', 'visibility'], 'localOnly');
    const run = await drive({ replies: [patchLines(spec)] });
    expect(run.regenerations).toBe(0);
    if (!run.result?.ok) throw new Error('expected acceptance');
    // the key is not in the element type, so the element is read as an unknown value
    const element: unknown = run.result.spec.elements.status;
    expect(element).toMatchObject({ visibility: 'localOnly' });
    expect(Object.isFrozen(element)).toBe(false);
    expect(Object.isFrozen(run.result.spec.elements)).toBe(false);
  });

  it('a widened visibility class is still seen by the visibility check', async () => {
    const spec = canonical();
    setAt(spec, ['elements', 'status', 'visibility'], 'remoteOnly');
    const run = await drive({ replies: [patchLines(spec), good()] });
    expect(run.regenerations).toBe(1);
    expect(run.reprompts[0]).toBeDefined();
  });

  it('a mistyped marker reaches the catalog list as bad-props', async () => {
    for (const marker of [{ $state: 5 }, { $bindState: 5 }]) {
      const spec = canonical();
      setAt(spec, ['elements', 'pick'], {
        type: 'FilePicker',
        props: { label: 'in', value: marker },
      });
      const screen = isRecord(spec.elements) ? spec.elements.screen : undefined;
      if (!isRecord(screen) || !Array.isArray(screen.children)) throw new Error('bad fixture');
      screen.children.push('pick');
      const env = await envelopeOf(spec);
      expect(env.catalog.map((i) => i.code)).toContain('bad-props');
    }
  });
});
