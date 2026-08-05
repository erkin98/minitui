import { describe, it, expect } from 'vitest';
import { stripAnsi, hasEscape, PRESERVE_C0 } from '../src/ansi.js';
import { stripDangerousOscSegments, stripHyperlinks } from '../src/osc.js';
import { sanitize, sanitizeSpecStrings } from '../src/index.js';
import { runStream } from './run-stream.js';

const ESC = '\x1b';
const ST = '\x1b\\'; // String Terminator (ESC \)
const BEL = '\x07';

describe('stripAnsi', () => {
  it('removes a CSI cursor-move sequence but keeps the text', () => {
    expect(stripAnsi(`a${ESC}[2Jb`)).toBe('ab');
  });

  it('removes SGR color codes, keeping the visible text', () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe('red');
  });

  it('preserves tab, newline and carriage return', () => {
    expect(stripAnsi('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('caret-encodes a lone C0 control char (BEL) instead of dropping it silently', () => {
    expect(stripAnsi('a\x07b')).toBe('a^Gb');
  });

  it('caret-encodes a lone ESC that is not a known sequence', () => {
    expect(stripAnsi(`a${ESC}b`)).toBe('a^[b');
  });

  it('removes a C1 8-bit CSI (0x9b) sequence', () => {
    expect(stripAnsi('a\x9b2Jb')).toBe('ab');
  });

  it('removes a whole OSC span cleanly (no orphaned introducer)', () => {
    // stripDangerousOscSegments runs first in the real pipeline; any OSC that survives
    // to stripAnsi (e.g. an allowed OSC 8 link in default mode) must vanish as a
    // WHOLE sequence — never leave a stray `8;;` behind.
    const link = `${ESC}]8;;https://example.com${ESC}\\text${ESC}]8;;${ESC}\\`;
    expect(stripAnsi(`a${link}b`)).toBe('atextb');
  });

  it('strips a DEL (0x7f) character', () => {
    expect(stripAnsi('a\x7fb')).toBe('a^?b');
  });

  it('fails closed on an unterminated OSC introducer', () => {
    expect(stripAnsi(`a${ESC}]b`)).toBe('a');
  });

  it('fails closed on an unterminated APC introducer', () => {
    expect(stripAnsi(`a${ESC}_b`)).toBe('a');
  });

  it('removes an ST-terminated SOS string as a whole span', () => {
    expect(stripAnsi(`a${ESC}Xsecret${ESC}\\b`)).toBe('ab');
  });

  it('removes a C1-introduced OSC (0x9d) terminated by C1 ST (0x9c) as a whole span', () => {
    expect(stripAnsi('a\x9d52;c;evil\x9cb')).toBe('ab');
  });

  it('does not let a BEL terminate a DCS payload (BEL is data outside OSC)', () => {
    expect(stripAnsi(`a${ESC}Pdata\x07more${ESC}\\b`)).toBe('ab');
  });

  it('hasEscape returns false for clean text and true for control bytes', () => {
    expect(hasEscape('plain text')).toBe(false);
    expect(hasEscape(`x${ESC}[0m`)).toBe(true);
    expect(hasEscape('x\x07')).toBe(true);
  });

  it('returns text with no control bytes byte-identical', () => {
    // The fast path itself is proven by the exhaustive hasEscape sweep below;
    // this asserts only what it can see — the output equals the input.
    const clean = 'no escapes here at all';
    expect(stripAnsi(clean)).toBe(clean);
  });

  it('hasEscape fires on exactly the bytes the strip rewrites, and no others', () => {
    // The predicate and the rewrite rule are locked to each other through the
    // SAME PRESERVE_C0 constant, not to a second hand-written list: a byte the
    // slow paths re-emit unchanged (TAB/LF/CR) must not force the slow path.
    for (let code = 0x00; code <= 0xff; code++) {
      const rewritten =
        (code <= 0x1f && !PRESERVE_C0.has(code)) || code === 0x7f || (code >= 0x80 && code <= 0x9f);
      expect(hasEscape(String.fromCharCode(code)), `code point 0x${code.toString(16)}`).toBe(
        rewritten,
      );
    }
  });

  it('hasEscape stays true for text carrying BOTH a newline and a live escape', () => {
    expect(hasEscape(`a\nb${ESC}[0m`)).toBe(true);
  });
});

describe('stripDangerousOscSegments', () => {
  // The production consumer (index.ts sanitizeWith) branches on segment.kind: a
  // 'trusted-osc8' segment bypasses the residual strip, a 'text' segment does not.
  // Assert the [kind, value] pairs, never a joined string — joining erases the one
  // field the pipeline's safety decision reads.
  const segments = (text: string): ReadonlyArray<readonly [string, string]> =>
    stripDangerousOscSegments(text).map((s) => [s.kind, s.value] as const);

  const OSC8_CLOSE = `${ESC}]8;;${ST}`;

  it('drops an OSC 52 clipboard-write entirely (BEL-terminated)', () => {
    expect(segments(`x${ESC}]52;c;ZXZpbA==${BEL}y`)).toEqual([
      ['text', 'x'],
      ['text', 'y'],
    ]);
  });

  it('drops an OSC 52 clipboard-write entirely (ST-terminated)', () => {
    expect(segments(`x${ESC}]52;c;ZXZpbA==${ST}y`)).toEqual([
      ['text', 'x'],
      ['text', 'y'],
    ]);
  });

  it('keeps an OSC 8 hyperlink with an allowed https scheme, framed as trusted', () => {
    // Only the two frames are trusted; the label between them stays 'text' and so
    // remains subject to the residual strip.
    const open = `${ESC}]8;;https://example.com${ST}`;
    expect(segments(`a${open}text${OSC8_CLOSE}b`)).toEqual([
      ['text', 'a'],
      ['trusted-osc8', open],
      ['text', 'text'],
      ['trusted-osc8', OSC8_CLOSE],
      ['text', 'b'],
    ]);
  });

  it('strips the OSC 8 wrapper of a disallowed scheme but keeps the link text', () => {
    const evil = `${ESC}]8;;javascript:alert(1)${ST}click${OSC8_CLOSE}`;
    // No trusted-osc8 segment at all — the visible label survives as plain text.
    expect(segments(`a${evil}b`)).toEqual([
      ['text', 'a'],
      ['text', 'click'],
      ['text', 'b'],
    ]);
  });

  it('trusts an OSC 8 file:// link whose body is already canonical', () => {
    const open = `${ESC}]8;;file:///etc/passwd${ST}`;
    // file is allowlisted and the input is already canonical ESC-form, so the
    // rebuilt frames are byte-identical to the input frames.
    expect(segments(`${open}open${OSC8_CLOSE}`)).toEqual([
      ['trusted-osc8', open],
      ['text', 'open'],
      ['trusted-osc8', OSC8_CLOSE],
    ]);
  });

  it('drops an APC (Kitty graphics) payload entirely', () => {
    expect(segments(`a${ESC}_Gf=100,a=T;BASE64DATA${ST}b`)).toEqual([
      ['text', 'a'],
      ['text', 'b'],
    ]);
  });

  it('drops a DCS / Sixel payload entirely', () => {
    expect(segments(`a${ESC}Pq#0;2;0;0;0${ST}b`)).toEqual([
      ['text', 'a'],
      ['text', 'b'],
    ]);
  });

  it('drops a PM (privacy message) payload entirely', () => {
    expect(segments(`a${ESC}^secret${ST}b`)).toEqual([
      ['text', 'a'],
      ['text', 'b'],
    ]);
  });

  it('drops an SOS (start of string) payload entirely', () => {
    expect(segments(`a${ESC}Xsmuggled${ST}b`)).toEqual([
      ['text', 'a'],
      ['text', 'b'],
    ]);
  });

  it('drops a C1-introduced OSC 52 (0x9d) terminated by BEL', () => {
    expect(segments(`x\x9d52;c;ZXZpbA==${BEL}y`)).toEqual([
      ['text', 'x'],
      ['text', 'y'],
    ]);
  });

  it('drops an OSC 52 terminated by the C1 ST (0x9c)', () => {
    expect(segments(`x${ESC}]52;c;ZXZpbA==\x9cy`)).toEqual([
      ['text', 'x'],
      ['text', 'y'],
    ]);
  });

  it('drops a C1-introduced APC (0x9f) payload', () => {
    expect(segments(`a\x9fGf=100;DATA${ST}b`)).toEqual([
      ['text', 'a'],
      ['text', 'b'],
    ]);
  });

  it('does NOT let a BEL terminate a DCS payload — BEL is data outside OSC', () => {
    // Early termination at the BEL would leave `more ST` as visible junk.
    expect(segments(`a${ESC}Pdata${BEL}more${ST}b`)).toEqual([
      ['text', 'a'],
      ['text', 'b'],
    ]);
  });

  it('FAIL CLOSED: drops an unterminated OSC 52 from its introducer to end of input', () => {
    // Leaking `ESC]52;c;...` raw would leave the real terminal parsing an
    // open OSC and swallowing everything printed after us into its payload.
    expect(segments(`steal${ESC}]52;c;ZXZpbA==`)).toEqual([['text', 'steal']]);
  });

  it('FAIL CLOSED: drops an unterminated APC from its introducer to end of input', () => {
    expect(segments(`a${ESC}_Gf=100,a=T;BASE64`)).toEqual([['text', 'a']]);
  });

  it('normalizes an allowed OSC 8 link to the canonical ESC-form frame', () => {
    // BEL-terminated allowed open is rebuilt as `ESC]8;body ESC\` — parsed
    // parts only, never the raw input frame bytes. The trusted segments are
    // therefore ST-form even though every frame in the input was BEL-form.
    const belLink = `${ESC}]8;;https://example.com${BEL}text${ESC}]8;;${BEL}`;
    expect(segments(belLink)).toEqual([
      ['trusted-osc8', `${ESC}]8;;https://example.com${ST}`],
      ['text', 'text'],
      ['trusted-osc8', OSC8_CLOSE],
    ]);
  });

  it('drops the wrapper of an allowed-scheme OSC 8 whose body smuggles control bytes', () => {
    const evil = `${ESC}]8;;https://a\x9d52;c;evil${BEL}click${OSC8_CLOSE}`;
    // The scheme is allowlisted but the body is not printable ASCII, so nothing is
    // trusted: the smuggled C1 introducer never reaches a segment that bypasses
    // the residual strip.
    expect(segments(evil)).toEqual([['text', 'click']]);
  });

  it('strips bracketed-paste begin/end markers so the framing bytes cannot survive', () => {
    expect(segments(`${ESC}[200~rm -rf /${ESC}[201~`)).toEqual([['text', 'rm -rf /']]);
  });

  it('drops an iTerm2 OSC 1337 file-write directive', () => {
    expect(segments(`a${ESC}]1337;File=name=x:ZGF0YQ==${BEL}b`)).toEqual([
      ['text', 'a'],
      ['text', 'b'],
    ]);
  });

  it('leaves clean text untouched', () => {
    expect(segments('just plain text')).toEqual([['text', 'just plain text']]);
  });
});

describe('stripHyperlinks (OSC 8 width helper)', () => {
  it('removes a canonical OSC 8 open+close frame, leaving only the visible text', () => {
    const link = `${ESC}]8;;https://example.com${ST}text${ESC}]8;;${ST}`;
    expect(stripHyperlinks(`a${link}b`)).toBe('atextb');
  });

  it('leaves SGR untouched — the hyperlink frames are its only job', () => {
    // string-width drops SGR itself; the width helper must not touch color.
    expect(stripHyperlinks(`${ESC}[31mred${ESC}[0m`)).toBe(`${ESC}[31mred${ESC}[0m`);
  });

  it('returns text with no escape frames byte-identical', () => {
    expect(stripHyperlinks('plain columns')).toBe('plain columns');
  });
});

describe('sanitize', () => {
  it('runs OSC strip then ANSI strip (default allow:none removes color too)', () => {
    const evil = `${ESC}]52;c;ZXZpbA==${BEL}${ESC}[31mhello${ESC}[0m`;
    expect(sanitize(evil)).toBe('hello');
  });

  it('neutralizes a combined clipboard + cursor + BEL payload', () => {
    // OSC 52 + cursor-clear are removed; the bare BEL between them is a lone C0
    // control, so per the strip contract it is caret-encoded (^G), never dropped
    // silently — the visible text survives intact after it.
    const evil = `${ESC}]52;c;cHduZWQ=${ST}${ESC}[2J\x07text`;
    expect(sanitize(evil)).toBe('^Gtext');
  });

  it('keeps an allowed https OSC 8 link through the full pipeline (default mode reduces it to its visible text)', () => {
    // The chokepoint guarantees no raw ESC reaches the screen in default mode,
    // so an allowed link degrades cleanly to its visible text — never an
    // orphaned `8;;` fragment (the bug a kept-then-restripped OSC 8 produced).
    const link = `${ESC}]8;;https://example.com${ST}text${ESC}]8;;${ST}`;
    expect(sanitize(`a${link}b`)).toBe('atextb');
  });

  it('strips a disallowed-scheme OSC 8 link through the full pipeline, keeping only the visible text', () => {
    const evil = `${ESC}]8;;javascript:alert(1)${ST}click${ESC}]8;;${ST}`;
    expect(sanitize(`a${evil}b`)).toBe('aclickb');
  });

  it('with allow:renderer-sgr keeps color but still drops OSC 52 and cursor moves', () => {
    const input = `${ESC}]52;c;ZXZpbA==${BEL}${ESC}[31mred${ESC}[2J${ESC}[0m`;
    const out = sanitize(input, { allow: 'renderer-sgr' });
    expect(out).toContain(`${ESC}[31m`); // SGR color survives
    expect(out).toContain(`${ESC}[0m`); // SGR reset survives
    expect(out).toContain('red');
    expect(out).not.toContain('52;c'); // clipboard gone
    expect(out).not.toContain('2J'); // cursor clear gone
  });

  it('with allow:renderer-sgr keeps an allowed OSC 8 link LIVE (the allowlist made observable)', () => {
    const link = `${ESC}]8;;https://example.com${ST}text${ESC}]8;;${ST}`;
    expect(sanitize(`a${link}b`, { allow: 'renderer-sgr' })).toBe(`a${link}b`);
  });

  it('with allow:renderer-sgr still strips a disallowed-scheme OSC 8 wrapper', () => {
    const evil = `${ESC}]8;;javascript:alert(1)${ST}click${ESC}]8;;${ST}`;
    expect(sanitize(`a${evil}b`, { allow: 'renderer-sgr' })).toBe('aclickb');
  });

  it('with allow:renderer-sgr caret-encodes a bare ESC — never emits it raw', () => {
    expect(sanitize(`a${ESC}zb`, { allow: 'renderer-sgr' })).toBe('a^[zb');
  });

  it('with allow:renderer-sgr drops a private-parameter CSI even though it ends in m', () => {
    // ESC[>4;2m is modifyOtherKeys, not color — the strict SGR check
    // ([\d:;]* params only, ink's sanitize-ansi rule) rejects it.
    expect(sanitize(`a${ESC}[>4;2mb`, { allow: 'renderer-sgr' })).toBe('ab');
  });

  it('with allow:renderer-sgr an unterminated OSC 52 is dropped fail-closed', () => {
    expect(sanitize(`x${ESC}]52;c;ZXZpbA==`, { allow: 'renderer-sgr' })).toBe('x');
  });

  it('is a no-op for clean text under both modes', () => {
    expect(sanitize('plain')).toBe('plain');
    expect(sanitize('plain', { allow: 'renderer-sgr' })).toBe('plain');
  });

  it('preserves layout whitespace', () => {
    expect(sanitize('a\tb\nc')).toBe('a\tb\nc');
  });
});

describe('sanitizeStream', () => {
  it('sanitizes a single chunk', async () => {
    expect(await runStream([`${ESC}[31mred${ESC}[0m`])).toBe('red');
  });

  it('sanitizes an escape sequence split across two chunks', async () => {
    // OSC 52 clipboard split mid-sequence must not leak the first half. The
    // first chunk's tail `ESC]52;c;ZX` ENDS IN A LETTER but is NOT complete —
    // an OSC is only complete at its ST/BEL terminator, never at a letter.
    expect(await runStream([`x${ESC}]52;c;ZX`, `ZpbA==${BEL}y`])).toBe('xy');
  });

  it('never leaks an OSC 52 payload no matter where the chunk boundary falls', async () => {
    const full = `x${ESC}]52;c;ZXZpbA==${BEL}y`;
    for (let i = 1; i < full.length; i++) {
      expect(await runStream([full.slice(0, i), full.slice(i)])).toBe('xy');
    }
  });

  it('handles a CSI split right after the ESC byte', async () => {
    expect(await runStream([`a${ESC}`, `[2Jb`])).toBe('ab');
  });

  it('caret-encodes a dangling lone ESC at end of stream', async () => {
    expect(await runStream([`done${ESC}`])).toBe('done^[');
  });

  it('holds an unterminated OSC whose payload contains a LATER ESC (lastIndexOf would leak the live introducer)', async () => {
    // The first chunk's unterminated OSC 52 contains a later `ESC q`. A
    // hold-from-last-ESC splitter would emit `x ESC]52;c;ab` — a live OSC
    // introducer — to the screen. The forward scan holds from the FIRST
    // unterminated introducer instead.
    expect(await runStream([`x${ESC}]52;c;ab${ESC}q`, `${BEL}y`])).toBe('xy');
  });

  it('drops an unterminated OSC 52 fail-closed at flush', async () => {
    expect(await runStream([`x${ESC}]52;c;ZXZpbA==`])).toBe('x');
  });

  it('caps the carry: a >MAX_CARRY unterminated OSC is dropped fail-closed, memory stays bounded', async () => {
    // Once the cap trips, the buffered span is sanitized (the unterminated
    // OSC drops to end-of-buffer). Payload arriving AFTER the cap flush
    // becomes inert visible text — the documented ceiling: bounded memory
    // and no live bytes, at the cost of junk on a >8 KiB sequence.
    const out = await runStream([`x${ESC}]52;c;`, 'A'.repeat(9000), 'tail']);
    expect(out).toBe('xtail');
    expect(out).not.toContain(ESC);
  });

  it('passes clean text through unchanged', async () => {
    expect(await runStream(['hello ', 'world'])).toBe('hello world');
  });
});

// Every string here is built ONLY from bytes no strip path rewrites: printable
// ASCII, a multi-byte character, an astral character, and the three preserved
// C0 controls. Narrowing the control-scan predicate changes which of these take
// the fast path; it must change NONE of their output. This net passes before
// and after the narrowing — it is the safety proof, not the gate.
const PRESERVED_BYTE_CORPUS: readonly string[] = (() => {
  const pieces = ['plain', 'é', '漢', '😀', '\t', '\n', '\r', ' ', '~', '!@#$%'];
  const out: string[] = [];
  for (const head of pieces) for (const tail of pieces) out.push(head + tail + head);
  return out;
})();

describe('preserved-byte identity across all four strip paths', () => {
  it('returns every preserved-byte string unchanged one-shot and streamed, in both modes', async () => {
    for (const text of PRESERVED_BYTE_CORPUS) {
      const label = JSON.stringify(text);
      const split = Math.floor(text.length / 2);
      const chunks = [text.slice(0, split), text.slice(split)];
      expect(sanitize(text), `one-shot none ${label}`).toBe(text);
      expect(sanitize(text, { allow: 'renderer-sgr' }), `one-shot sgr ${label}`).toBe(text);
      expect(await runStream(chunks), `stream none ${label}`).toBe(text);
      expect(await runStream(chunks, { allow: 'renderer-sgr' }), `stream sgr ${label}`).toBe(text);
    }
  });
});

describe('sanitizeSpecStrings', () => {
  it('cleans every nested string prop and returns a new object', () => {
    const spec = {
      root: 'r',
      elements: {
        r: { type: 'Text', props: { label: `${ESC}]52;c;ZXZpbA==${BEL}${ESC}[31mhi${ESC}[0m` } },
      },
    };
    const out = sanitizeSpecStrings(spec);
    expect(out.elements.r.props.label).toBe('hi');
    expect(out).not.toBe(spec); // new object
    expect(out.elements.r.props).not.toBe(spec.elements.r.props);
  });

  it('does not mutate the input (immutability)', () => {
    const dirty = `a${ESC}[2Jb`;
    const spec = { elements: { x: { props: { t: dirty } } } };
    sanitizeSpecStrings(spec);
    expect(spec.elements.x.props.t).toBe(dirty); // original untouched
  });

  it('cleans strings inside arrays', () => {
    const spec = { items: [`x${ESC}[0m`, 'clean', `${ESC}]52;c;ZA==${BEL}`] };
    const out = sanitizeSpecStrings(spec);
    expect(out.items).toEqual(['x', 'clean', '']);
  });

  it('leaves numbers, booleans and null untouched', () => {
    const spec = { n: 1, b: true, z: null, s: `${ESC}[0mok` };
    const out = sanitizeSpecStrings(spec);
    expect(out).toEqual({ n: 1, b: true, z: null, s: 'ok' });
  });

  // The clean-key case lives in security-regressions.test.ts, next to the
  // dirty-key witness it is the companion to. It was duplicated here byte for
  // byte; two copies of one assertion is one assertion.

  it('rejects a JSON-parse-produced own __proto__ key', () => {
    const spec = JSON.parse(`{"__proto__":{"polluted":"${'\\u001b'}[31mx"},"ok":"v"}`) as Record<
      string,
      unknown
    >;
    expect(() => sanitizeSpecStrings(spec)).toThrow(TypeError);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
});
