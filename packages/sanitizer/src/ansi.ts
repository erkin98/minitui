// ANSI / control-character strip. Built once at module scope (strip-ansi pattern):
// the RegExp is compiled a single time, and a cheap ESC/C1/control pre-check
// (hasEscape) skips the replace entirely for the common all-printable case.
// Grammar mirrors ink's reference tokenizer (repos/ink/src/ansi-tokenizer.ts):
// string sequences have ESC-form AND C1-form introducers, ST is ESC \ or the
// C1 ST 0x9c, and BEL (0x07) terminates OSC ONLY — in DCS/PM/APC/SOS it is data.

// C0 controls that are layout-safe and must survive: TAB, LF, CR.
export const PRESERVE_C0: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0d]);

// String Terminator: ESC \ or the 8-bit C1 ST (0x9c).
const ST = '(?:\\x1b\\\\|\\x9c)';

// String-parameter sequences, both introducer forms:
//   OSC  ESC ] / 0x9d   — terminated by ST or BEL
//   DCS  ESC P / 0x90, PM ESC ^ / 0x9e, APC ESC _ / 0x9f, SOS ESC X / 0x98
//                       — terminated by ST ONLY (a BEL in the payload is data)
// osc.ts runs FIRST and resolves the dangerous ones fail-closed; anything that
// survives to here (e.g. an allowed OSC 8 link in the default path) must be
// removed as a WHOLE span — never matched as `ESC] + final byte`, which would
// orphan the `8;;` tail. This is why `]`, `_`, `P`, `^`, `X` are all excluded
// from ANSI_SEQUENCE's 2-byte-escape alternative below.
// A doubled ESC (ESC ESC) inside a control-string payload is a tmux-escaped
// literal ESC, not the start of the ST — the pair is consumed as one unit so the
// terminator search does not stop one byte early (mirrors ink's doubled-ESC
// skip). `BODY` replaces the old `[\s\S]*?`.
const BODY = '(?:\\x1b\\x1b|[\\s\\S])*?';
const STRING_SEQUENCE = new RegExp(
  `(?:\\x1b\\]|\\x9d)${BODY}(?:${ST}|\\x07)` +
    `|(?:\\x1b[_P^X]|[\\x90\\x98\\x9e\\x9f])${BODY}${ST}`,
  'g',
);

// CSI/SGR and other ESC-introduced escape sequences, three ordered alternatives.
// Uses ink's ECMA-48 byte classes (repos/ink/src/ansi-tokenizer.ts) for what
// FORMS a sequence, but keeps minitui's stricter fallback: a bare ESC + an
// UNCURATED single final byte is NOT stripped here — it falls through to the
// caret-encode loop below (a visible `^[c`), so an unknown escape is neutralized
// AND made visible, never silently swallowed. Only recognizable structured forms
// are stripped:
//   1. CSI — ESC[ or C1 0x9b, params 0x30-0x3f, intermediates 0x20-0x2f, one
//      final 0x40-0x7e. ONLY `ESC[`/0x9b introduce a CSI. The old grammar also
//      fired on `ESC( ESC) ESC# ESC; ESC?`, over-consuming the following
//      character (`ESC ; Z` silently deleted the Z) — the real content-loss bug;
//   2. ESC + one-or-more intermediates 0x20-0x2f + one final 0x30-0x7e — a
//      structured multi-byte escape (e.g. `ESC ( B` charset select), stripped as
//      one unit so a chunk split between the intermediate and its final cannot
//      diverge from the one-shot output;
//   3. ESC + one CURATED final byte — the known one-byte-final escapes. The set
//      deliberately excludes the string-parameter introducers (P X ] ^ _) so an
//      unterminated string sequence reaching this mop-up layer degrades to a
//      caret-encoded ESC, never a half-consumed introducer with a dangling
//      payload. An uncurated final (e.g. RIS `ESC c`, `ESC b`) is left for the
//      caret-encode loop — safe (no live ESC) and visible, per minitui's posture.
const ANSI_SEQUENCE =
  // eslint-disable-next-line no-control-regex
  /(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b[\x20-\x2f]+[\x30-\x7e]|\x1b[@-OQ-WYZ\\]/g;

// Any byte that is ESC, a C1 control (0x80-0x9f), DEL, or a non-preserved C0.
// eslint-disable-next-line no-control-regex
const CONTROL_SCAN = /[\x00-\x1f\x7f-\x9f]/;

export function hasEscape(text: string): boolean {
  return CONTROL_SCAN.test(text);
}

// Exported: index.ts's renderer-sgr scanner reuses the exact same encoding.
// Caret notation (cat -v style), ASCII-only by design — see Architecture.
export function caretEncode(code: number): string {
  if (code === 0x7f) return '^?'; // DEL
  if (code <= 0x1f) return '^' + String.fromCharCode(code + 0x40); // ^@ .. ^_
  // C1 (0x80-0x9f): render as ^[ + the 7-bit equivalent letter
  return '^[' + String.fromCharCode(code - 0x40);
}

export function stripAnsi(text: string): string {
  if (!hasEscape(text)) return text; // fast path: nothing to strip
  // 1. Remove well-formed escape sequences wholesale — string-parameter spans
  //    (OSC/APC/DCS/PM/SOS, both introducer forms) first, then CSI/SGR and
  //    the simple 2-byte escapes.
  const withoutSequences = text.replace(STRING_SEQUENCE, '').replace(ANSI_SEQUENCE, '');
  // 2. Caret-encode any control byte left over (lone ESC, BEL, DEL, C1, ...),
  //    preserving TAB/LF/CR so layout is not destroyed.
  let out = '';
  for (const ch of withoutSequences) {
    const code = ch.codePointAt(0)!;
    if (
      (code <= 0x1f && !PRESERVE_C0.has(code)) ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f)
    ) {
      out += caretEncode(code);
    } else {
      out += ch;
    }
  }
  return out;
}
