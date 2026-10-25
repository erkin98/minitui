import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineMinituiCatalog } from '@minitui/catalog';
import { composeValidation, toWireSpec } from '../src/loop.js';
import type { CapabilityProvider } from '../src/capability-port.js';
import type { MiniAppSpec } from '../src/spec-types.js';
import {
  addChild,
  canonical,
  caps as portCaps,
  drive,
  good,
  lastEnvelope,
  patchLines,
  setAt,
} from './support/driver.js';

async function* once(s: string): AsyncIterable<string> {
  yield s;
}

const caps: CapabilityProvider = {
  listEncoders: async () => ['libx264'],
  listCodecs: async () => ['h264'],
  listFilters: async () => ['scale'],
  statFile: async () => ({ exists: true, readable: true, isFile: true }),
};

// A REAL catalog handle with Box registered (typed MinituiCatalog,
// no `as never`/hand-rolled shell). composeValidation CALLS runFullValidation
// against it, so the handle must be a working catalog — the factory is the same
// one every catalog is built with.
const catalog = defineMinituiCatalog({
  id: 'test',
  components: {
    Box: { props: z.object({}).strict(), slots: [], description: 'box', trustTier: 'display' },
  },
  actions: {},
});

const validSpecJsonl =
  '{"op":"add","path":"/root","value":"f"}\n' +
  '{"op":"add","path":"/elements","value":{"f":{"type":"Box","props":{}}}}\n' +
  '{"op":"add","path":"/state","value":{}}\n';

describe('composeValidation', () => {
  it('returns ok with a MiniAppSpec when the first stream is valid', async () => {
    const r = await composeValidation({
      stream: once(validSpecJsonl),
      catalog,
      capabilities: caps,
      regenerate: () => once(validSpecJsonl),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.root).toBe('f');
  });

  it('reprompts with the envelope text, then succeeds on the regenerated stream', async () => {
    const badJsonl = '{"op":"add","path":"/elements","value":{}}\n'; // no root
    let seenReprompt = '';
    const r = await composeValidation({
      stream: once(badJsonl),
      catalog,
      capabilities: caps,
      regenerate: (reprompt) => {
        seenReprompt = reprompt;
        return once(validSpecJsonl);
      },
    });
    expect(seenReprompt).toContain('root');
    expect(r.ok).toBe(true);
  });

  it('rejects an off-catalog component through the catalog gate and reprompts', async () => {
    // Structurally valid, but "Iframe" is not registered in the catalog — only
    // runFullValidation can catch it. This is the wiring proof for the dead-catalog
    // case: if the loop never called the gate, this spec would pass.
    const offCatalogJsonl =
      '{"op":"add","path":"/root","value":"f"}\n' +
      '{"op":"add","path":"/elements","value":{"f":{"type":"Iframe","props":{}}}}\n' +
      '{"op":"add","path":"/state","value":{}}\n';
    let seenReprompt = '';
    const r = await composeValidation({
      stream: once(offCatalogJsonl),
      catalog,
      capabilities: caps,
      regenerate: (reprompt) => {
        seenReprompt = reprompt;
        return once(validSpecJsonl);
      },
    });
    expect(seenReprompt).toContain('Iframe'); // runFullValidation's unknown-component message
    expect(r.ok).toBe(true);
  });

  it('rejects an agent-widened visibility through the visibility gate and reprompts', async () => {
    // Box is catalog-declared with the default clientOnly class; the agent smuggles
    // a wider `visibility: 'remoteOnly'` onto the element — an excess field the wire
    // type does not model and strict-props never sees. Only checkVisibility catches it
    // (it runs after the catalog gate, before the port-semantic probes).
    const widenedJsonl =
      '{"op":"add","path":"/root","value":"f"}\n' +
      '{"op":"add","path":"/elements","value":{"f":{"type":"Box","props":{},"visibility":"remoteOnly"}}}\n' +
      '{"op":"add","path":"/state","value":{}}\n';
    let seenReprompt = '';
    const r = await composeValidation({
      stream: once(widenedJsonl),
      catalog,
      capabilities: caps,
      regenerate: (reprompt) => {
        seenReprompt = reprompt;
        return once(validSpecJsonl);
      },
    });
    expect(seenReprompt).toContain('visibility'); // checkVisibility's widen message
    expect(r.ok).toBe(true);
  });

  it('gives up after MAX_RETRIES with the last envelope', async () => {
    const badJsonl = '{"op":"add","path":"/elements","value":{}}\n';
    const r = await composeValidation({
      stream: once(badJsonl),
      catalog,
      capabilities: caps,
      regenerate: () => once(badJsonl),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.lastEnvelope.code).toBe('VALIDATION_FAILED');
      expect(r.lastEnvelope.attempt).toBe(6); // total passes = MAX_RETRIES+1 (1 initial + 5 regenerations)
    }
  });

  it('turns a model-stream compile throw into a reprompt, never escaping', async () => {
    // A failing RFC-6902 `test` op throws inside json-render's applySpecStreamPatch;
    // the untrusted-boundary catch converts it to a repair attempt, not a crash.
    const throwingJsonl = '{"op":"test","path":"/root","value":"nope"}\n';
    let seenReprompt = '';
    const r = await composeValidation({
      stream: once(throwingJsonl),
      catalog,
      capabilities: caps,
      regenerate: (reprompt) => {
        seenReprompt = reprompt;
        return once(validSpecJsonl);
      },
    });
    expect(seenReprompt).toContain('did not compile');
    expect(r.ok).toBe(true);
  });

  it('survives an empty stream by reprompting rather than throwing', async () => {
    const r = await composeValidation({
      stream: once(''),
      catalog,
      capabilities: caps,
      regenerate: () => once(''),
    });
    expect(r.ok).toBe(false); // never resolves to a spec, but never throws
  });
});

describe('toWireSpec', () => {
  it('toWireSpec is state-free at runtime — drops state and meta', () => {
    const mini: MiniAppSpec = {
      root: 'r',
      elements: {},
      state: { secret: 'x' },
      meta: { catalogId: 'c', schemaVersion: 1, sourcePrompt: 'user prompt' },
    };
    const wire = toWireSpec(mini);
    expect(Object.keys(wire).sort()).toEqual(['elements', 'root']);
    expect('state' in wire).toBe(false);
    expect('meta' in wire).toBe(false);
  });
});

describe('composeValidation: the source stream', () => {
  class ProviderError extends Error {}

  async function* failingAfter(chunk: string, error: unknown): AsyncIterable<string> {
    if (chunk !== '') yield chunk;
    throw error;
  }

  const badReply = 'PRIVATE-LINE-TEXT is not json\n';

  it('an error of the source leaves the loop as the same object, with no regeneration', async () => {
    const failure = new ProviderError('upstream failed');
    const run = await drive({
      replies: [good()],
      streams: [failingAfter(patchLines({ root: 'screen' }), failure)],
    });
    expect(run.thrown).toBe(failure);
    expect(run.thrown).toBeInstanceOf(ProviderError);
    expect(run.regenerations).toBe(0);
  });

  it('an abort leaves the loop as the same object', async () => {
    const abort = new DOMException('stopped', 'AbortError');
    const run = await drive({ replies: [good()], streams: [failingAfter('', abort)] });
    expect(run.thrown).toBe(abort);
    expect(run.regenerations).toBe(0);
  });

  it('an error of a regenerated stream leaves the loop after exactly that regeneration', async () => {
    const failure = new ProviderError('second stream failed');
    const run = await drive({
      replies: [badReply],
      streams: [once(badReply), failingAfter('', failure)],
    });
    expect(run.thrown).toBe(failure);
    expect(run.regenerations).toBe(1);
  });

  it('an error after a partial line was buffered still leaves as the same object', async () => {
    const failure = new ProviderError('cut off');
    const run = await drive({
      replies: [good()],
      streams: [failingAfter('{"op":"add","path":"/ro', failure)],
    });
    expect(run.thrown).toBe(failure);
    expect(run.regenerations).toBe(0);
  });

  it('a line that is not JSON is one regeneration; the reprompt says JSONL and not the line', async () => {
    const run = await drive({ replies: [badReply, good()] });
    expect(run.result?.ok).toBe(true);
    expect(run.regenerations).toBe(1);
    expect(run.reprompts[0]).toContain('JSONL');
    expect(run.reprompts[0]).toContain('did not compile');
    expect(run.reprompts[0]).not.toContain('PRIVATE-LINE-TEXT');
  });

  it('a failing test operation is one regeneration; the reprompt holds neither path nor value', async () => {
    const run = await drive({
      replies: ['{"op":"test","path":"/root","value":"PRIVATE-VALUE"}\n', good()],
    });
    expect(run.result?.ok).toBe(true);
    expect(run.regenerations).toBe(1);
    expect(run.reprompts[0]).toContain('did not compile');
    expect(run.reprompts[0]).not.toContain('/root');
    expect(run.reprompts[0]).not.toContain('PRIVATE-VALUE');
  });

  it('a reserved segment is one regeneration; the reprompt names it and holds no escape byte', async () => {
    const esc = String.fromCharCode(27);
    const jsonEscape = '\\u001b';
    const run = await drive({
      replies: [`{"op":"add","path":"/__proto__/x${jsonEscape}[2J","value":1}\n`, good()],
    });
    expect(run.regenerations).toBe(1);
    expect(run.reprompts[0]).toContain('reserved prototype segment');
    expect(run.reprompts[0]).not.toContain(esc);
  });

  it('a malformed reply on every pass gives up after five regenerations with attempt 6', async () => {
    const run = await drive({ replies: [badReply] });
    expect(run.regenerations).toBe(5);
    const envelope = run.result?.ok === false ? run.result.lastEnvelope : undefined;
    expect(envelope?.attempt).toBe(6);
    expect(envelope?.structural.map((i) => i.code)).toEqual(['empty_spec']);
    expect(envelope?.structural[0]?.message).toContain('did not compile');
    expect(envelope?.catalog).toEqual([]);
    expect(envelope?.semantic).toEqual([]);
  });

  it('control: the valid stream is accepted with no regeneration', async () => {
    const run = await drive({ replies: [good()] });
    expect(run.result?.ok).toBe(true);
    expect(run.regenerations).toBe(0);
  });
});

describe('composeValidation: conditions', () => {
  const withVisible = (visible: unknown) => {
    const spec = canonical();
    setAt(spec, ['elements', 'status', 'visible'], visible);
    return patchLines(spec);
  };
  const condition = (envelopeOf: ReturnType<typeof lastEnvelope>) => {
    expect(envelopeOf.structural.map((i) => i.code)).toEqual(['empty_spec']);
    expect(envelopeOf.structural[0]?.message).toContain('condition');
    expect(envelopeOf.catalog).toEqual([]);
    expect(envelopeOf.semantic).toEqual([]);
  };

  it.each([[null], [[null]], [{ $and: 1 }], [5], [{}]])(
    'a bad visible value %j is one regeneration on the structural list',
    async (visible) => {
      const run = await drive({ replies: [withVisible(visible), good()] });
      expect(run.result?.ok).toBe(true);
      expect(run.regenerations).toBe(1);
      expect(run.reprompts[0]).toContain('condition');
    },
  );

  it('a bad visible value on every pass ends with the fixed condition message', async () => {
    const run = await drive({ replies: [withVisible({ $and: 'PRIVATE-CONDITION-TEXT' })] });
    expect(run.regenerations).toBe(5);
    condition(lastEnvelope(run));
    expect(run.reprompts.join('\n')).not.toContain('PRIVATE-CONDITION-TEXT');
  });

  it('a visible value written inside props is moved out by auto-fix and then judged', async () => {
    const spec = canonical();
    setAt(spec, ['elements', 'status', 'props', 'visible'], null);
    const run = await drive({ replies: [patchLines(spec)] });
    condition(lastEnvelope(run));
  });

  it('a bad $cond in a prop is refused', async () => {
    const spec = canonical();
    setAt(spec, ['elements', 'status', 'props', 'text'], {
      $cond: [null],
      $then: 'a',
      $else: 'b',
    });
    condition(lastEnvelope(await drive({ replies: [patchLines(spec)] })));
  });

  it('a bad $cond in the params of a binding is refused', async () => {
    const spec = canonical();
    setAt(spec, ['elements', 'merge', 'on', 'press', 'params', 'extra'], {
      $cond: {},
      $then: 1,
      $else: 2,
    });
    condition(lastEnvelope(await drive({ replies: [patchLines(spec)] })));
  });

  it.each([
    [true],
    [false],
    [{ $state: '/codec' }],
    [{ $state: '/codec', eq: 'h264' }],
    [{ $state: '/output', not: true }],
    [[{ $state: '/codec' }, { $state: '/output' }]],
    [{ $and: [{ $state: '/codec' }, true] }],
    [{ $or: [{ $state: '/codec' }, { $state: '/later/key' }] }],
  ])('control: the taught visible value %j is accepted with no regeneration', async (visible) => {
    const run = await drive({ replies: [withVisible(visible)] });
    expect(run.result?.ok).toBe(true);
    expect(run.regenerations).toBe(0);
  });
});

describe('composeValidation: the state document', () => {
  const BEL = String.fromCharCode(7);
  const ESC = String.fromCharCode(27);
  const libraryWords = /Invalid input|Unrecognized key|\bexpected\b|\breceived\b/;

  const withState = (state: unknown) => {
    const spec = canonical();
    setAt(spec, ['state'], state);
    return patchLines(spec);
  };
  const stateLine = (valueJson: string) =>
    patchLines(canonical(), ['state']) + `{"op":"add","path":"/state","value":${valueJson}}\n`;

  const expectStateEnvelope = async (reply: string): Promise<void> => {
    const run = await drive({ replies: [reply, good()] });
    expect(run.result?.ok).toBe(true);
    expect(run.regenerations).toBe(1);
    const reprompt = run.reprompts[0] ?? '';
    expect(reprompt).toContain('state');
    expect(reprompt).not.toMatch(libraryWords);
    expect(reprompt).not.toContain(ESC);
    expect(reprompt).not.toContain(BEL);
    const every = await drive({ replies: [reply] });
    const envelope = lastEnvelope(every);
    expect(envelope.structural.map((i) => i.code)).toEqual(['empty_spec']);
    expect(envelope.structural[0]?.message).toContain('state');
    expect(envelope.catalog).toEqual([]);
    expect(envelope.semantic).toEqual([]);
  };

  it.each([[0], [''], [false], [[]], [[1, 2]], ['x'], [5], [true]])(
    'a state of %j is refused as a state problem',
    async (state) => {
      await expectStateEnvelope(withState(state));
    },
  );

  it('a missing state line and a null state are the empty object', async () => {
    // a spec with no state bindings, so that an empty state is complete
    const plain = {
      root: 'note',
      elements: { note: { type: 'Text', props: { text: 'hello' } } },
    };
    for (const reply of [patchLines(plain), patchLines({ ...plain, state: null })]) {
      const run = await drive({ replies: [reply] });
      expect(run.regenerations).toBe(0);
      expect(run.result?.ok === true ? run.result.spec.state : undefined).toEqual({});
    }
  });

  it.each([
    ['a top-level key with a BEL byte', { [`a${BEL}b`]: 1 }],
    ['an ESC sequence in a nested key', { outer: { [`k${ESC}[31m`]: 1 } }],
    ['a key inside an array member', { rows: [{ [`k${BEL}`]: 1 }] }],
  ])('%s is refused as a state problem', async (_name, state) => {
    await expectStateEnvelope(withState(state));
  });

  it.each([
    ['an own __proto__ key', '{"__proto__":{"polluted":true}}'],
    ['a nested own constructor key', '{"a":{"constructor":{"polluted":true}}}'],
  ])('%s is refused and the global prototype stays clean', async (_name, valueJson) => {
    await expectStateEnvelope(stateLine(valueJson));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('control: the valid spec returns the state it was sent, frozen', async () => {
    const run = await drive({ replies: [good()] });
    expect(run.regenerations).toBe(0);
    const state = run.result?.ok === true ? run.result.spec.state : undefined;
    expect(state).toEqual(canonical().state);
    expect(Object.isFrozen(state)).toBe(true);
  });

  it('control: keys with spaces, dots and non-ASCII characters are accepted', async () => {
    const spec = canonical();
    const state = { ...(spec.state as Record<string, unknown>) };
    for (const key of ['out put', 'a.b', 'naïve', '日本']) state[key] = key;
    setAt(spec, ['state'], state);
    const run = await drive({ replies: [patchLines(spec)] });
    expect(run.result?.ok).toBe(true);
    expect(run.regenerations).toBe(0);
  });
});

describe('composeValidation: the screen of the whole reply', () => {
  const SCREEN_MESSAGE = 'no usable spec: emit JSONL patch lines that add /root and /elements';
  const line = (path: string, valueJson: string) =>
    `{"op":"add","path":"/${path}","value":${valueJson}}\n`;
  const box = '{"type":"Box","props":{}}';

  // Each text is built as JSON text so that an own __proto__ key is real data, as JSON.parse makes it.
  const deepProp = (levels: number): string => {
    let value = '1';
    for (let i = 0; i < levels; i++) value = `{"n":${value}}`;
    return value;
  };
  const refused: Array<[string, string]> = [
    [
      'an own __proto__ key inside an element',
      line('root', '"a"') + line('elements', `{"a":{"type":"Box","props":{},"__proto__":{"x":1}}}`),
    ],
    [
      'an own __proto__ key in the elements map',
      line('root', '"a"') + line('elements', `{"a":${box},"__proto__":{"b":${box}}}`),
    ],
    [
      'a root that exists only on the prototype of the elements map',
      line('root', '"ghost"') + line('elements', `{"__proto__":{"ghost":${box}}}`),
    ],
    [
      'an element named constructor',
      line('root', '"a"') + line('elements', `{"a":${box},"constructor":${box}}`),
    ],
    [
      'an element named prototype',
      line('root', '"a"') + line('elements', `{"a":${box},"prototype":${box}}`),
    ],
    ['an empty reply', ''],
    ['a whole-object reply that is not a patch line', '{"root":"a","elements":{}}\n'],
    ['elements and no root', line('elements', `{"a":${box}}`)],
    ['a root and no elements', line('root', '"a"')],
    [
      'a prop nested 300 levels deep',
      line('root', '"a"') +
        line('elements', `{"a":{"type":"Box","props":{"deep":${deepProp(300)}}}}`),
    ],
    [
      'a prop array of 70,000 numbers',
      line('root', '"a"') +
        line(
          'elements',
          `{"a":{"type":"Box","props":{"big":[${new Array(70000).fill('1').join(',')}]}}}`,
        ),
    ],
  ];

  it.each(refused)('%s ends with the screen message on every pass', async (_name, reply) => {
    const run = await drive({ replies: [reply] });
    expect(run.regenerations).toBe(5);
    const envelope = lastEnvelope(run);
    expect(envelope.structural.map((i) => i.code)).toEqual(['empty_spec']);
    expect(envelope.structural.map((i) => i.message)).toEqual([SCREEN_MESSAGE]);
    expect(envelope.catalog).toEqual([]);
    expect(envelope.semantic).toEqual([]);
  });

  it.each(refused)(
    '%s costs one regeneration, then a good reply is accepted',
    async (_name, reply) => {
      const run = await drive({ replies: [reply, good()] });
      expect(run.result?.ok).toBe(true);
      expect(run.regenerations).toBe(1);
      expect(run.reprompts[0]).toContain('root');
    },
  );

  it('control: the canonical spec is accepted with no regeneration', async () => {
    const run = await drive({ replies: [good()] });
    expect(run.result?.ok).toBe(true);
    expect(run.regenerations).toBe(0);
  });
});

describe('composeValidation: the first failure is kept', () => {
  const missingFile: CapabilityProvider = {
    ...portCaps,
    statFile: async () => ({ exists: false, readable: false, isFile: false }),
  };
  const withPicker = () => {
    const spec = canonical();
    addChild(spec, 'screen', 'pick', {
      type: 'FilePicker',
      props: { label: 'in', value: 'a.mp4' },
    });
    return patchLines(spec);
  };

  it('after six failures the first envelope still names the real cause', async () => {
    // the first stream is the picker spec; every regeneration is an empty stream
    const run = await drive({ replies: [withPicker(), ''], capabilities: missingFile });
    expect(run.regenerations).toBe(5);
    if (run.result === undefined || run.result.ok) throw new Error('expected a give-up result');
    expect(run.result.firstEnvelope.attempt).toBe(1);
    expect(run.result.firstEnvelope.semantic.map((i) => i.code)).toEqual(['missing_file']);
    expect(run.result.lastEnvelope.attempt).toBe(6);
    expect(run.result.lastEnvelope.structural.map((i) => i.message)).toEqual([
      'no usable spec: emit JSONL patch lines that add /root and /elements',
    ]);
  });

  it('a missing file is one regeneration; the reprompt says so', async () => {
    const run = await drive({ replies: [withPicker(), good()], capabilities: missingFile });
    expect(run.result?.ok).toBe(true);
    expect(run.regenerations).toBe(1);
    expect(run.reprompts[0]).toContain('does not exist');
    const every = await drive({ replies: [withPicker()], capabilities: missingFile });
    expect(lastEnvelope(every).semantic.map((i) => i.code)).toEqual(['missing_file']);
  });

  it('a repeat target that is not in state is one regeneration; the reprompt says so', async () => {
    const spec = canonical();
    addChild(spec, 'screen', 'rows', { type: 'Box', props: {}, repeat: { statePath: '/nope' } });
    const run = await drive({ replies: [patchLines(spec), good()] });
    expect(run.regenerations).toBe(1);
    expect(run.reprompts[0]).toContain('does not resolve');
    const every = await drive({ replies: [patchLines(spec)] });
    expect(lastEnvelope(every).semantic.map((i) => i.code)).toEqual(['unresolved_binding']);
  });

  it('a final line with no newline is applied', async () => {
    const run = await drive({ replies: [good().trimEnd()] });
    expect(run.result?.ok).toBe(true);
    expect(run.regenerations).toBe(0);
    expect(run.result?.ok === true ? run.result.spec.state : undefined).toEqual(canonical().state);
  });

  it('the loop calls regenerate five times at most', async () => {
    const run = await drive({ replies: ['not a patch\n'] });
    expect(run.regenerations).toBe(5);
  });
});

describe('composeValidation: stream details and structure', () => {
  const op = (value: Record<string, unknown>): string => JSON.stringify(value) + '\n';

  it('a whole-element copy attached as a child of the root is accepted', async () => {
    const reply =
      good() +
      op({ op: 'copy', from: '/elements/status', path: '/elements/status2' }) +
      op({ op: 'add', path: '/elements/screen/children/-', value: 'status2' });
    const run = await drive({ replies: [reply] });
    expect(run.result?.ok).toBe(true);
    expect(run.regenerations).toBe(0);
  });

  it('clones past the budget reprompt once with did not compile', async () => {
    const big = new Array<number>(32768).fill(1);
    const reply =
      good() +
      op({ op: 'add', path: '/state/xs', value: big }) +
      op({ op: 'copy', from: '/state/xs', path: '/state/a' }) +
      op({ op: 'copy', from: '/state/xs', path: '/state/b' });
    const run = await drive({ replies: [reply, good()] });
    expect(run.result?.ok).toBe(true);
    expect(run.regenerations).toBe(1);
    expect(run.reprompts[0]).toContain('did not compile');
  });

  it.each([
    { key: 'on', value: { press: { action: 'merge' } }, code: 'on_in_props' },
    { key: 'visible', value: true, code: 'visible_in_props' },
    { key: 'repeat', value: { statePath: '/inputs' }, code: 'repeat_in_props' },
  ])('$key at both levels is one regeneration with the adopted code $code', async (row) => {
    const spec = canonical();
    setAt(spec, ['elements', 'status', 'props', row.key], row.value);
    setAt(spec, ['elements', 'status', row.key], row.value);
    const run = await drive({ replies: [patchLines(spec), good()] });
    expect(run.regenerations).toBe(1);
    const every = await drive({ replies: [patchLines(spec)] });
    expect(lastEnvelope(every).structural.map((i) => i.code)).toContain(row.code);
    if (row.key === 'on') expect(run.reprompts[0]).toContain('has "on" inside "props"');
  });

  it('a repeat target that is a string in state is one regeneration on the semantic list', async () => {
    const spec = canonical();
    addChild(spec, 'screen', 'rows', { type: 'Box', props: {}, repeat: { statePath: '/codec' } });
    const run = await drive({ replies: [patchLines(spec), good()] });
    expect(run.regenerations).toBe(1);
    const every = await drive({ replies: [patchLines(spec)] });
    expect(lastEnvelope(every).semantic.map((i) => i.code)).toEqual(['unresolved_binding']);
  });
});
