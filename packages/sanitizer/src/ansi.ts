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
const STRING_SEQUENCE = new RegExp(
  // eslint-disable-next-line no-control-regex
  `(?:\\x1b\\]|\\x9d)[\\s\\S]*?(?:${ST}|\\x07)` +
    `|(?:\\x1b[_P^X]|[\\x90\\x98\\x9e\\x9f])[\\s\\S]*?${ST}`,
  'g',
);

// CSI/SGR and other ESC-introduced escape sequences, including the 8-bit C1
// CSI (0x9b). Covers: ESC[ ... final, ESC + one of the simple 2-byte escapes.
// The 2-byte alternative deliberately excludes every string-parameter
// introducer (P 0x50, X 0x58, ] 0x5d, ^ 0x5e, _ 0x5f): an UNTERMINATED string
// sequence reaching this mop-up layer must degrade to a caret-encoded ESC plus
// inert text, never a consumed introducer with its payload left dangling.
const ANSI_SEQUENCE =
  // eslint-disable-next-line no-control-regex
  /(?:\x1b[[()#;?]|\x9b)[0-?]*[ -/]*[@-~]|\x1b[@-OQ-WYZ\\]/g;

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
