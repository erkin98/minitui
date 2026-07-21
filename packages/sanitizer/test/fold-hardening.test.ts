import { describe, it, expect } from 'vitest';
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

// ── C12 — ALLOWED_OSC8_SCHEMES is a runtime-immutable allowlist ──────────────
describe('C12 — ALLOWED_OSC8_SCHEMES is frozen at runtime, not just typed ReadonlySet', () => {
  it('rejects .add — an in-process caller cannot widen the OSC 8 scheme allowlist', () => {
    const mutate = ALLOWED_OSC8_SCHEMES as Set<string>;
    expect(() => mutate.add('javascript')).toThrow();
  });

  it('is Object.frozen', () => {
    expect(Object.isFrozen(ALLOWED_OSC8_SCHEMES)).toBe(true);
  });

  it('POSITIVE CONTROL: after an attempted .add, a javascript: OSC 8 is still stripped', () => {
    // Before the fix, ALLOWED_OSC8_SCHEMES.add('javascript') stuck and this
    // returned the raw OSC 8 escape with the javascript: URI intact.
    try {
      (ALLOWED_OSC8_SCHEMES as Set<string>).add('javascript');
    } catch {
      /* frozen — mutation rejected, which is the point */
    }
    const evil = `${ESC}]8;;javascript:alert(1)${ST}click${ESC}]8;;${ST}`;
    expect(sanitize(`a${evil}b`, { allow: 'renderer-sgr' })).toBe('aclickb');
    expect(ALLOWED_OSC8_SCHEMES.has('javascript')).toBe(false);
  });
});

// ── C06 — sanitizeSpecStrings sanitizes dynamic object KEYS too ──────────────
describe('C06 — sanitizeSpecStrings sanitizes object keys, keeping reference integrity', () => {
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

  it('resolves a post-sanitize key collision deterministically (last in key order wins)', () => {
    const spec: Record<string, number> = {};
    spec['root'] = 1;
    spec[`ro${ESC}[31mot`] = 2; // sanitizes to the same "root"
    const out = sanitizeSpecStrings(spec);
    expect(Object.keys(out)).toEqual(['root']);
    expect(out['root']).toBe(2); // last key in Object.keys order wins
  });
});

// ── C07 / PIN-DEPTH — bounded recursion, fail-closed, never RangeError ───────
function nest(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { leaf: 'x' };
  for (let i = 0; i < depth; i++) node = { a: node };
  return node;
}

describe('C07 — sanitizeSpecStrings bounds recursion depth, failing closed', () => {
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

  it('POSITIVE CONTROL: a shallow spec is fully preserved (guard does not over-fire)', () => {
    const shallow = nest(10);
    let node: unknown = sanitizeSpecStrings(shallow);
    for (let i = 0; i < 10; i++) node = (node as { a: unknown }).a;
    expect(node).toEqual({ leaf: 'x' });
  });
});

// ── C11 — doubled-ESC (tmux) + full ECMA-48 ESC intermediate/final grammar ───
describe('C11 — doubled-ESC control strings and the ESC intermediate/final grammar', () => {
  it('a doubled ESC inside a DCS payload is literal (tmux) — the whole DCS is consumed', () => {
    // ESC ESC is tmux-escaped payload, NOT the start of the ST. The non-greedy
    // terminator must skip it and keep scanning for the real ESC \ so the nested
    // SGR does not leak as visible "hidden" text (default mode, live path).
    const dcs = `${ESC}Ppayload${ESC}${ESC}\\${ESC}[31mhidden${ESC}\\`;
    expect(sanitize(`A${dcs}Z`)).toBe('AZ');
  });

  it('does not eat the following char after a bare ESC + non-CSI byte (no content loss)', () => {
    // The old CSI alternative wrongly fired on `ESC ;` (`;` treated as a CSI
    // introducer) and swallowed the following `Z` -> 'A' (silent content loss).
    // Now `;` is not a CSI introducer, so the ESC caret-encodes and Z survives.
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

  it('SECURITY FLOOR holds: no case leaks a raw ESC or C1 control', () => {
    const cases = [`A${ESC};Z`, `A${ESC}cZ`, `A${ESC}(BZ`, `A${ESC}Ppayload${ESC}${ESC}\\Z`];
    for (const c of cases) {
      // eslint-disable-next-line no-control-regex
      expect(sanitize(c)).not.toMatch(/[\x1b\x80-\x9f]/);
    }
  });
});

// ── C01 — OSC 8 open/close pairing state survives across sanitize calls ──────
const OSC8_OPEN = `${ESC}]8;;https://example.com${ST}`;
const OSC8_CLOSE = `${ESC}]8;;${ST}`;

describe('C01 — OSC 8 open/close pairing survives chunk boundaries and intervening OSC', () => {
  it('renderer-sgr stream: an open in one chunk and its close in the next stay paired', async () => {
    // Before the fix, the close arrived in a fresh sanitize() call whose pairing
    // state was reset, so the close was dropped -> an unmatched OSC 8 open that
    // swallows all later text into the hyperlink.
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

  it('POSITIVE CONTROL: a disallowed open in a stream drops both halves, keeping text', async () => {
    const evilOpen = `${ESC}]8;;javascript:x${ST}`;
    const out = await runStream([`${evilOpen}click`, OSC8_CLOSE], { allow: 'renderer-sgr' });
    expect(out).toBe('click');
    expect(out).not.toContain('javascript');
  });
});
