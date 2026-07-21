import { describe, it, expect } from 'vitest';
import { stripAnsi, hasEscape } from '../src/ansi.js';

const ESC = '\x1b';

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
