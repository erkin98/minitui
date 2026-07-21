import { describe, it, expect } from 'vitest';
import { stripAnsi, hasEscape } from '../src/ansi.js';
import { stripDangerousOsc, stripHyperlinks } from '../src/osc.js';
import { sanitize, sanitizeStream } from '../src/index.js';

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
    // stripDangerousOsc runs first in the real pipeline; any OSC that survives
    // to stripAnsi (e.g. an allowed OSC 8 link in default mode) must vanish as a
    // WHOLE sequence — never leave a stray `8;;` behind.
    const link = `${ESC}]8;;https://example.com${ESC}\\text${ESC}]8;;${ESC}\\`;
    expect(stripAnsi(`a${link}b`)).toBe('atextb');
  });

  it('strips a DEL (0x7f) character', () => {
    expect(stripAnsi('a\x7fb')).toBe('a^?b');
  });

  it('caret-encodes a lone ESC before an OSC introducer instead of consuming it', () => {
    // Regression: the 2-byte-escape alternative must NOT swallow `ESC]` —
    // an unterminated OSC that reaches this mop-up layer degrades to a
    // visible `^[` marker plus its inert text, never a half-eaten introducer.
    expect(stripAnsi(`a${ESC}]b`)).toBe('a^[]b');
  });

  it('caret-encodes a lone ESC before an APC introducer instead of consuming it', () => {
    expect(stripAnsi(`a${ESC}_b`)).toBe('a^[_b');
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

  it('hasEscape fast-paths plain text without running the strip', () => {
    const clean = 'no escapes here at all';
    expect(stripAnsi(clean)).toBe(clean);
  });
});

describe('stripDangerousOsc', () => {
  it('drops an OSC 52 clipboard-write entirely (BEL-terminated)', () => {
    expect(stripDangerousOsc(`x${ESC}]52;c;ZXZpbA==${BEL}y`)).toBe('xy');
  });

  it('drops an OSC 52 clipboard-write entirely (ST-terminated)', () => {
    expect(stripDangerousOsc(`x${ESC}]52;c;ZXZpbA==${ST}y`)).toBe('xy');
  });

  it('keeps an OSC 8 hyperlink with an allowed https scheme', () => {
    const link = `${ESC}]8;;https://example.com${ST}text${ESC}]8;;${ST}`;
    expect(stripDangerousOsc(`a${link}b`)).toBe(`a${link}b`);
  });

  it('strips the OSC 8 wrapper of a disallowed scheme but keeps the link text', () => {
    const evil = `${ESC}]8;;javascript:alert(1)${ST}click${ESC}]8;;${ST}`;
    expect(stripDangerousOsc(`a${evil}b`)).toBe('aclickb');
  });

  it('strips an OSC 8 file:// link that smuggles a payload but keeps the text', () => {
    const evil = `${ESC}]8;;file:///etc/passwd${ST}open${ESC}]8;;${ST}`;
    // file is allowlisted and the input is already canonical ESC-form,
    // so the rebuilt link is byte-identical to the input
    expect(stripDangerousOsc(evil)).toBe(evil);
  });

  it('drops an APC (Kitty graphics) payload entirely', () => {
    expect(stripDangerousOsc(`a${ESC}_Gf=100,a=T;BASE64DATA${ST}b`)).toBe('ab');
  });

  it('drops a DCS / Sixel payload entirely', () => {
    expect(stripDangerousOsc(`a${ESC}Pq#0;2;0;0;0${ST}b`)).toBe('ab');
  });

  it('drops a PM (privacy message) payload entirely', () => {
    expect(stripDangerousOsc(`a${ESC}^secret${ST}b`)).toBe('ab');
  });

  it('drops an SOS (start of string) payload entirely', () => {
    expect(stripDangerousOsc(`a${ESC}Xsmuggled${ST}b`)).toBe('ab');
  });

  it('drops a C1-introduced OSC 52 (0x9d) terminated by BEL', () => {
    expect(stripDangerousOsc(`x\x9d52;c;ZXZpbA==${BEL}y`)).toBe('xy');
  });

  it('drops an OSC 52 terminated by the C1 ST (0x9c)', () => {
    expect(stripDangerousOsc(`x${ESC}]52;c;ZXZpbA==\x9cy`)).toBe('xy');
  });

  it('drops a C1-introduced APC (0x9f) payload', () => {
    expect(stripDangerousOsc(`a\x9fGf=100;DATA${ST}b`)).toBe('ab');
  });

  it('does NOT let a BEL terminate a DCS payload — BEL is data outside OSC', () => {
    // Early termination at the BEL would leave `more ST` as visible junk.
    expect(stripDangerousOsc(`a${ESC}Pdata${BEL}more${ST}b`)).toBe('ab');
  });

  it('FAIL CLOSED: drops an unterminated OSC 52 from its introducer to end of input', () => {
    // Leaking `ESC]52;c;...` raw would leave the real terminal parsing an
    // open OSC and swallowing everything printed after us into its payload.
    expect(stripDangerousOsc(`steal${ESC}]52;c;ZXZpbA==`)).toBe('steal');
  });

  it('FAIL CLOSED: drops an unterminated APC from its introducer to end of input', () => {
    expect(stripDangerousOsc(`a${ESC}_Gf=100,a=T;BASE64`)).toBe('a');
  });

  it('normalizes an allowed OSC 8 link to the canonical ESC-form frame', () => {
    // BEL-terminated allowed open is rebuilt as `ESC]8;body ESC\` — parsed
    // parts only, never the raw input frame bytes.
    const belLink = `${ESC}]8;;https://example.com${BEL}text${ESC}]8;;${BEL}`;
    const canonical = `${ESC}]8;;https://example.com${ST}text${ESC}]8;;${ST}`;
    expect(stripDangerousOsc(belLink)).toBe(canonical);
  });

  it('drops the wrapper of an allowed-scheme OSC 8 whose body smuggles control bytes', () => {
    const evil = `${ESC}]8;;https://a\x9d52;c;evil${BEL}click${ESC}]8;;${ST}`;
    const out = stripDangerousOsc(evil);
    expect(out).toContain('click');
    expect(out).not.toContain('\x9d');
    expect(out).not.toContain('52;c');
  });

  it('strips bracketed-paste begin/end markers so the framing bytes cannot survive', () => {
    expect(stripDangerousOsc(`${ESC}[200~rm -rf /${ESC}[201~`)).toBe('rm -rf /');
  });

  it('drops an iTerm2 OSC 1337 file-write directive', () => {
    expect(stripDangerousOsc(`a${ESC}]1337;File=name=x:ZGF0YQ==${BEL}b`)).toBe('ab');
  });

  it('leaves clean text untouched', () => {
    expect(stripDangerousOsc('just plain text')).toBe('just plain text');
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

  it('is a no-op for text with no escape frames (fast path)', () => {
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
