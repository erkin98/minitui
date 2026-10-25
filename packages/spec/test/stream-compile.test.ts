import { describe, it, expect } from 'vitest';
import { JsonValueSchema } from '@minitui/types';
import { compileSpecStream, SpecStreamContentError } from '../src/stream-compile.js';

async function* chunks(parts: string[]): AsyncIterable<string> {
  for (const p of parts) yield p;
}

describe('compileSpecStream', () => {
  it('applies add patches and tolerates a chunk split mid-line', async () => {
    const lines = [
      '{"op":"add","path":"/root","value":"f"}\n',
      '{"op":"add","path":"/elements","value":{}}\n',
      '{"op":"add","path":"/elem', // split mid-line
      'ents/f","value":{"type":"Box","props":{}}}\n',
      '{"op":"add","path":"/state","value":{}}\n',
    ];
    const spec = await compileSpecStream(chunks(lines));
    expect(spec.root).toBe('f');
    expect(spec.elements.f).toEqual({ type: 'Box', props: {} });
    expect(spec.state).toEqual({});
  });

  it('rejects a patch whose path walks a prototype segment and leaves Object.prototype clean', async () => {
    for (const seg of ['__proto__', 'constructor', 'prototype']) {
      await expect(
        compileSpecStream(chunks([`{"op":"add","path":"/${seg}/polluted","value":true}\n`])),
      ).rejects.toThrow(/reserved prototype segment/);
    }
    // the pollutable sink never ran: the global prototype is untouched
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects a reserved segment reached via a from pointer (move/copy)', async () => {
    await expect(
      compileSpecStream(chunks(['{"op":"move","from":"/__proto__/x","path":"/root"}\n'])),
    ).rejects.toThrow(/reserved prototype segment/);
  });
});

async function rejection(stream: AsyncIterable<string>): Promise<unknown> {
  try {
    await compileSpecStream(stream);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('compileSpecStream: content errors are tagged and carry fixed text', () => {
  it('a line that is not JSON rejects with the content class and says JSONL, not the line', async () => {
    const error = await rejection(chunks(['PRIVATE-LINE-TEXT is not json\n']));
    expect(error).toBeInstanceOf(SpecStreamContentError);
    const message = error instanceof Error ? error.message : '';
    expect(message).toContain('JSONL');
    expect(message).not.toContain('PRIVATE-LINE-TEXT');
  });

  it('a failing test operation rejects with the content class and holds neither path nor value', async () => {
    const error = await rejection(
      chunks(['{"op":"test","path":"/root","value":"PRIVATE-VALUE"}\n']),
    );
    expect(error).toBeInstanceOf(SpecStreamContentError);
    const message = error instanceof Error ? error.message : '';
    expect(message).not.toContain('/root');
    expect(message).not.toContain('PRIVATE-VALUE');
  });

  it('a reserved segment rejects with the content class and does not repeat the path', async () => {
    const esc = String.fromCharCode(27);
    const jsonEscape = '\\u001b';
    const error = await rejection(
      chunks([`{"op":"add","path":"/__proto__/x${jsonEscape}[2J","value":1}\n`]),
    );
    expect(error).toBeInstanceOf(SpecStreamContentError);
    const message = error instanceof Error ? error.message : '';
    expect(message).toContain('reserved prototype segment');
    expect(message).not.toContain('__proto__');
    expect(message).not.toContain(esc);
  });

  it.each([['null'], ['5'], ['"text"'], ['[]'], ['{}'], ['{"op":"add"}']])(
    'a line that is JSON but not a patch is skipped: %s',
    async (line) => {
      const spec = await compileSpecStream(
        chunks([`${line}\n`, '{"op":"add","path":"/root","value":"f"}\n']),
      );
      expect(spec.root).toBe('f');
    },
  );

  it('an error of the source passes as the same object and is not a content error', async () => {
    const failure = new Error('source failed');
    async function* failing(): AsyncIterable<string> {
      yield '{"op":"add","path":"/root","value":"f"}\n';
      throw failure;
    }
    const error = await rejection(failing());
    expect(error).toBe(failure);
    expect(error).not.toBeInstanceOf(SpecStreamContentError);
  });
});

describe('compileSpecStream: the last line', () => {
  it('keeps a final line that has no newline', async () => {
    const spec = await compileSpecStream(
      chunks([
        '{"op":"add","path":"/root","value":"f"}\n',
        '{"op":"add","path":"/state","value":{"a":1}}',
      ]),
    );
    expect(spec.root).toBe('f');
    expect(spec.state).toEqual({ a: 1 });
  });
});

describe('compileSpecStream: lines are applied one by one', () => {
  const op = (value: Record<string, unknown>): string => JSON.stringify(value) + '\n';
  const add = (path: string, value: unknown) => op({ op: 'add', path, value });
  const numbers = (count: number): number[] => new Array<number>(count).fill(1);

  it('two identical appends both land', async () => {
    const spec = await compileSpecStream(
      chunks([
        add('/state', { inputs: [] }),
        add('/state/inputs/-', 'clip.mp4'),
        add('/state/inputs/-', 'clip.mp4'),
      ]),
    );
    expect(spec.state).toEqual({ inputs: ['clip.mp4', 'clip.mp4'] });
  });

  it('remove, add, remove of one path ends with the path absent', async () => {
    const spec = await compileSpecStream(
      chunks([
        add('/state', { tmp: 0 }),
        op({ op: 'remove', path: '/state/tmp' }),
        add('/state/tmp', 1),
        op({ op: 'remove', path: '/state/tmp' }),
      ]),
    );
    expect(spec.state).toEqual({});
  });

  it('replace 1, replace 2, replace 1 ends at 1', async () => {
    const replace = (value: number) => op({ op: 'replace', path: '/state/n', value });
    const spec = await compileSpecStream(
      chunks([add('/state', { n: 0 }), replace(1), replace(2), replace(1)]),
    );
    expect(spec.state).toEqual({ n: 1 });
  });

  const withElements = [
    add('/root', 'screen'),
    add('/elements', {
      screen: { type: 'Box', props: {}, children: ['status'] },
      status: { type: 'Text', props: { text: 'a' } },
    }),
  ];

  it('a whole-element copy leaves no value in two places and the copy is independent', async () => {
    const spec = await compileSpecStream(
      chunks([
        ...withElements,
        op({ op: 'copy', from: '/elements/status', path: '/elements/status2' }),
        op({ op: 'replace', path: '/elements/status2/props/text', value: 'b' }),
      ]),
    );
    expect(JsonValueSchema.safeParse({ root: spec.root, elements: spec.elements }).success).toBe(
      true,
    );
    expect(spec.elements.status?.props.text).toBe('a');
    expect(spec.elements.status2?.props.text).toBe('b');
  });

  it('a copy of one array item inside one element gives two distinct objects', async () => {
    const spec = await compileSpecStream(
      chunks([
        add('/elements', { codec: { type: 'Select', props: { options: [{ label: 'a' }] } } }),
        op({
          op: 'copy',
          from: '/elements/codec/props/options/0',
          path: '/elements/codec/props/options/-',
        }),
      ]),
    );
    const options = spec.elements.codec?.props.options;
    expect(Array.isArray(options) ? options.length : 0).toBe(2);
    expect(Array.isArray(options) && options[0] !== options[1]).toBe(true);
  });

  it('a copy of a primitive is applied as before', async () => {
    const spec = await compileSpecStream(
      chunks([add('/state', { a: 'x' }), op({ op: 'copy', from: '/state/a', path: '/state/b' })]),
    );
    expect(spec.state).toEqual({ a: 'x', b: 'x' });
  });

  it('a move takes the value out of its old place', async () => {
    const spec = await compileSpecStream(
      chunks([
        ...withElements,
        op({ op: 'move', from: '/elements/status', path: '/elements/moved' }),
      ]),
    );
    expect(spec.elements.status).toBeUndefined();
    expect(spec.elements.moved?.props.text).toBe('a');
  });

  it('clones within the node budget are accepted', async () => {
    const spec = await compileSpecStream(
      chunks([
        add('/state', { xs: numbers(32767) }),
        op({ op: 'copy', from: '/state/xs', path: '/state/a' }),
        op({ op: 'copy', from: '/state/xs', path: '/state/b' }),
      ]),
    );
    expect(Array.isArray(spec.state?.b)).toBe(true);
  });

  it('the copy that passes the budget is a content error with the fixed text', async () => {
    const error = await rejection(
      chunks([
        add('/state', { xs: numbers(32768) }),
        op({ op: 'copy', from: '/state/xs', path: '/state/a' }),
        op({ op: 'copy', from: '/state/xs', path: '/state/b' }),
      ]),
    );
    expect(error).toBeInstanceOf(SpecStreamContentError);
    expect(error instanceof Error ? error.message : '').toContain('could not be applied');
  });

  it('control: a reserved segment is still rejected and the global prototype stays clean', async () => {
    const error = await rejection(chunks([add('/__proto__/polluted', true)]));
    expect(error).toBeInstanceOf(SpecStreamContentError);
    expect(error instanceof Error ? error.message : '').toContain('reserved prototype segment');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('a copy keeps an own __proto__ key as data', async () => {
    const spec = await compileSpecStream(
      chunks([
        '{"op":"add","path":"/state","value":{"src":{"__proto__":{"x":1}}}}\n',
        op({ op: 'copy', from: '/state/src', path: '/state/dst' }),
      ]),
    );
    const dst = spec.state?.dst;
    expect(Object.getPrototypeOf(dst)).toBe(Object.prototype);
    expect(JsonValueSchema.safeParse(spec.state).success).toBe(false);
  });
});
