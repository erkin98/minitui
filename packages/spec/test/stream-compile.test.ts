import { describe, it, expect } from 'vitest';
import { compileSpecStream } from '../src/stream-compile.js';

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

  it('rejects a patch whose path walks a prototype segment (§Z84) and leaves Object.prototype clean', async () => {
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
