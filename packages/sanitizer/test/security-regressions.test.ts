import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import {
  sanitize,
  sanitizeStream,
  sanitizeSpecStrings,
  ALLOWED_OSC8_SCHEMES,
} from '../src/index.js';

const ESC = '\x1b';
const ST = '\x1b\\'; // String Terminator (ESC \)
const BEL = '\x07';

async function runStream(
  chunks: string[],
  opts?: { allow?: 'none' | 'renderer-sgr' | undefined },
): Promise<string> {
  const t = sanitizeStream(opts);
  const writer = t.writable.getWriter();
  const reader = t.readable.getReader();
  const out: string[] = [];
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }
  })();
  for (const c of chunks) await writer.write(c);
  await writer.close();
  await pump;
  return out.join('');
}

describe('ALLOWED_OSC8_SCHEMES runtime immutability', () => {
  it('rejects .add so an in-process caller cannot widen the allowlist', () => {
    const mutate = ALLOWED_OSC8_SCHEMES as Set<string>;
    expect(() => mutate.add('javascript')).toThrow();
  });

  it('is Object.frozen', () => {
    expect(Object.isFrozen(ALLOWED_OSC8_SCHEMES)).toBe(true);
  });

  it('rejects direct and borrowed native Set mutation methods', () => {
    const runtime = ALLOWED_OSC8_SCHEMES as Set<string>;
    expect(() => runtime.delete('https')).toThrow();
    expect(() => runtime.clear()).toThrow();
    expect(() => Set.prototype.add.call(runtime, 'javascript')).toThrow();
    expect(() => Set.prototype.delete.call(runtime, 'https')).toThrow();
    expect(() => Set.prototype.clear.call(runtime)).toThrow();
    expect([...ALLOWED_OSC8_SCHEMES]).toEqual(['https', 'http', 'file', 'mailto']);
  });

  it('still strips javascript links after an attempted mutation', () => {
    try {
      (ALLOWED_OSC8_SCHEMES as Set<string>).add('javascript');
    } catch {
      /* The immutable facade rejects mutation. */
    }
    const evil = `${ESC}]8;;javascript:alert(1)${ST}click${ESC}]8;;${ST}`;
    expect(sanitize(`a${evil}b`, { allow: 'renderer-sgr' })).toBe('aclickb');
    expect(ALLOWED_OSC8_SCHEMES.has('javascript')).toBe(false);
  });
});

describe('sanitizeSpecStrings object-key integrity', () => {
  it('an ANSI-bearing element key is sanitized so root/child references still resolve', () => {
    // A schema-valid AppSpec where an element map key carries ANSI. root/children
    // string VALUES get sanitized; without key sanitize the key stays raw and the
    // reference dangles (Object.hasOwn(elements, root) flips true->false).
    const spec = {
      root: 'root',
      elements: {
        [`ro${ESC}[31mot`]: { type: 'Text', props: { label: 'hi' } },
      },
    };
    const out = sanitizeSpecStrings(spec);
    expect(Object.keys(out.elements)).toEqual(['root']); // key stripped of ANSI
    expect(Object.hasOwn(out.elements, out.root)).toBe(true); // reference resolves
  });

  it('a clean key is left unchanged (RFC-6901-style pointer keys survive)', () => {
    const spec = { '/inputs/0': `${ESC}[31mv${ESC}[0m` };
    const out = sanitizeSpecStrings(spec);
    expect(Object.keys(out)).toEqual(['/inputs/0']);
    expect(out['/inputs/0']).toBe('v');
  });

  it('rejects a post-sanitize key collision instead of retargeting a binding', () => {
    const spec: Record<string, number> = {};
    spec['root'] = 1;
    spec[`ro${ESC}[31mot`] = 2; // sanitizes to the same "root"
    expect(() => sanitizeSpecStrings(spec)).toThrow(TypeError);
  });

  it('rejects reserved input keys and keys that sanitize to a reserved name', () => {
    const reserved = JSON.parse('{"__proto__":1}') as Record<string, unknown>;
    expect(() => sanitizeSpecStrings(reserved)).toThrow(TypeError);
    expect(() => sanitizeSpecStrings({ [`__${ESC}[31mproto__`]: 1 })).toThrow(TypeError);
  });
});

function nest(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { leaf: 'x' };
  for (let i = 0; i < depth; i++) node = { a: node };
  return node;
}

describe('sanitizeSpecStrings depth bounds', () => {
  it('a 5000-deep spec drops the over-deep subtree to null instead of throwing RangeError', () => {
    const deep = nest(5000);
    let out: unknown;
    expect(() => {
      out = sanitizeSpecStrings(deep);
    }).not.toThrow();
    let node: unknown = out;
    let d = 0;
    while (node !== null && typeof node === 'object' && 'a' in node) {
      node = (node as { a: unknown }).a;
      d++;
      if (d > 1000) break;
    }
    expect(node).toBeNull(); // over-deep subtree dropped to inert null
    expect(d).toBeLessThan(300); // bounded near the 256 ceiling
  });

  it('fully preserves a shallow spec', () => {
    const shallow = nest(10);
    let node: unknown = sanitizeSpecStrings(shallow);
    for (let i = 0; i < 10; i++) node = (node as { a: unknown }).a;
    expect(node).toEqual({ leaf: 'x' });
  });

  it('checks depth before scalar leaves', () => {
    let value: unknown = 'leaf';
    for (let i = 0; i < 257; i++) value = { child: value };
    let node: unknown = sanitizeSpecStrings(value);
    for (let i = 0; i < 257; i++) {
      if (node === null || typeof node !== 'object') break;
      node = (node as { child: unknown }).child;
    }
    expect(node).toBeNull();
  });
});

describe('doubled-ESC control strings and the ESC intermediate/final grammar', () => {
  it('treats a doubled ESC inside a DCS payload as literal payload', () => {
    // ESC ESC is tmux-escaped payload, NOT the start of the ST. The non-greedy
    // terminator must skip it and keep scanning for the real ESC \ so the nested
    // SGR does not leak as visible "hidden" text (default mode, live path).
    const dcs = `${ESC}Ppayload${ESC}${ESC}\\${ESC}[31mhidden${ESC}\\`;
    expect(sanitize(`A${dcs}Z`)).toBe('AZ');
  });

  it('does not eat the following char after a bare ESC + non-CSI byte (no content loss)', () => {
    // `;` is not a CSI introducer, so the ESC is caret-encoded and Z survives.
    expect(sanitize(`A${ESC};Z`)).toBe('A^[;Z');
    expect(sanitize(`A${ESC};Z`)).toContain('Z');
  });

  it('neutralizes an uncurated escape (RIS ESC c) via caret-encode, keeping content', () => {
    // 'c' (0x63, RIS) is not in the curated strip set; per minitui's posture an
    // uncurated escape is caret-encoded (visible) not stripped — safe (no live
    // ESC resets the terminal) and the surrounding text is preserved.
    expect(sanitize(`A${ESC}cZ`)).toBe('A^[cZ');
  });

  it('an ESC escape with an intermediate byte (ESC ( B) is stripped as one unit', () => {
    expect(sanitize(`A${ESC}(BZ`)).toBe('AZ');
  });

  it('streaming and one-shot agree on an ESC-with-intermediate split across chunks', async () => {
    const streamed = await runStream([`A${ESC}(`, 'BZ']);
    const oneShot = sanitize(`A${ESC}(BZ`);
    expect(streamed).toBe(oneShot);
    expect(streamed).toBe('AZ');
  });

  it('streaming and one-shot agree on an ESC + C1 control-string introducer split', async () => {
    // ESC then a C1 OSC introducer (0x9d) whose ST terminator lands in the next
    // chunk. The scanner must hold the ESC and reconsider the C1 as its own
    // introducer, not swallow ESC+0x9d as a 2-byte escape and prematurely emit the
    // OSC payload as visible text. Splitting there always failed safe (no live
    // escape reached the output) but did not produce byte-equal output.
    const OSC = '\x9d';
    const full = `A${ESC}${OSC}payloadmore;${ST}`;
    const streamed = await runStream([`A${ESC}${OSC}payload`, `more;${ST}`]);
    expect(streamed).toBe(sanitize(full));
    expect(streamed).toBe('A^['); // whole C1 OSC string stripped; the lone ESC caret-encoded
  });

  it('never leaks a raw ESC or C1 control', () => {
    const cases = [`A${ESC};Z`, `A${ESC}cZ`, `A${ESC}(BZ`, `A${ESC}Ppayload${ESC}${ESC}\\Z`];
    for (const c of cases) {
      // eslint-disable-next-line no-control-regex
      expect(sanitize(c)).not.toMatch(/[\x1b\x80-\x9f]/);
    }
  });

  it('does not reinterpret doubled ESC as a string terminator when no real ST follows', () => {
    expect(sanitize(`A${ESC}Ppayload${ESC}${ESC}\\SECRET`)).toBe('A');
  });

  it('lets the outer OSC own its BEL terminator instead of parsing an inner family', () => {
    const nested = `A${ESC}]52;c;payload${ESC}Pinner${BEL}VISIBLE${ST}Z`;
    expect(sanitize(nested)).toBe('AVISIBLEZ');
  });

  it('reconsiders the second ESC at a stream overlap boundary', async () => {
    const full = `${ESC}${ESC}^secret${ST}`;
    expect(await runStream([`${ESC}${ESC}`, `^secret${ST}`])).toBe(sanitize(full));
    expect(sanitize(full)).toBe('^[');
  });

  it('handles an unterminated repeated-ESC input within a bounded time', () => {
    const hostile = `A${ESC}]52;c;${ESC.repeat(38)}tail`;
    const started = performance.now();
    expect(sanitize(hostile)).toBe('A');
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('matches one-shot output at every single split offset', async () => {
    const cases = [
      {
        text: `é漢😀A${ESC}]52;c;payload${ESC}Pinner${BEL}VISIBLE${ST}Z`,
        opts: undefined,
      },
      { text: `${ESC}${ESC}^secret${ST}after`, opts: undefined },
      {
        text: `${OSC8_OPEN}é漢😀label${OSC8_CLOSE}after`,
        opts: { allow: 'renderer-sgr' } as const,
      },
    ];

    for (const testCase of cases) {
      const expected = sanitize(testCase.text, testCase.opts);
      for (let split = 0; split <= testCase.text.length; split++) {
        const actual = await runStream(
          [testCase.text.slice(0, split), testCase.text.slice(split)],
          testCase.opts,
        );
        expect(actual, `split ${split} of ${JSON.stringify(testCase.text)}`).toBe(expected);
      }
    }
  });
});

const OSC8_OPEN = `${ESC}]8;;https://example.com${ST}`;
const OSC8_CLOSE = `${ESC}]8;;${ST}`;

describe('OSC 8 pairing across chunks and intervening control strings', () => {
  it('renderer-sgr stream: an open in one chunk and its close in the next stay paired', async () => {
    const out = await runStream([`${OSC8_OPEN}text`, OSC8_CLOSE], { allow: 'renderer-sgr' });
    expect(out).toBe(`${OSC8_OPEN}text${OSC8_CLOSE}`);
  });

  it('one-shot renderer-sgr: an intervening OSC 52 does not drop the OSC 8 close', () => {
    // The dropped OSC 52 between the open and close must not reset the pairing
    // state; the close still pairs with the kept open.
    const osc52 = `${ESC}]52;c;ZXZpbA==${BEL}`;
    const out = sanitize(`${OSC8_OPEN}text${osc52}${OSC8_CLOSE}`, { allow: 'renderer-sgr' });
    expect(out).toBe(`${OSC8_OPEN}text${OSC8_CLOSE}`);
    expect(out).not.toContain('52;c'); // OSC 52 still stripped
  });

  it('drops both wrappers for a disallowed streamed link while keeping its text', async () => {
    const evilOpen = `${ESC}]8;;javascript:x${ST}`;
    const out = await runStream([`${evilOpen}click`, OSC8_CLOSE], { allow: 'renderer-sgr' });
    expect(out).toBe('click');
    expect(out).not.toContain('javascript');
  });

  it('emits an unmatched allowed link label as plain text at one-shot and stream finalization', async () => {
    const unmatched = `${OSC8_OPEN}visible`;
    expect(sanitize(unmatched, { allow: 'renderer-sgr' })).toBe('visible');
    expect(await runStream([OSC8_OPEN, 'visible'], { allow: 'renderer-sgr' })).toBe('visible');
  });

  it('flushes an older nested allowed link as plain text and keeps only the matched inner pair', () => {
    const nested = `${OSC8_OPEN}outer${OSC8_OPEN}inner${OSC8_CLOSE}`;
    expect(sanitize(nested, { allow: 'renderer-sgr' })).toBe(`outer${OSC8_OPEN}inner${OSC8_CLOSE}`);
  });

  it('does not let a nested disallowed open unbalance an allowed outer link', () => {
    const disallowed = `${ESC}]8;;javascript:x${ST}`;
    const nested = `${OSC8_OPEN}before${disallowed}after${OSC8_CLOSE}`;
    expect(sanitize(nested, { allow: 'renderer-sgr' })).toBe(
      `${OSC8_OPEN}beforeafter${OSC8_CLOSE}`,
    );
  });

  it('drops the wrapper after the pending label cap while preserving the full label', async () => {
    const label = 'x'.repeat(8193);
    const out = await runStream([OSC8_OPEN, label, OSC8_CLOSE], { allow: 'renderer-sgr' });
    expect(out).toBe(label);
    expect(out).not.toContain(ESC);
  });
});
