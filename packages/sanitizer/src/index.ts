// @minitui/sanitizer — ANSI/control-character chokepoint leaf (zero-dep).
// The single import every package routes untrusted text through before the screen.
import { caretEncode, hasEscape, stripAnsi } from './ansi.js';
import { stripDangerousOsc, ALLOWED_OSC8_SCHEMES, stripHyperlinks } from './osc.js';

export interface SanitizeOptions {
  /**
   * 'none' (default) strips all escapes incl. SGR; 'renderer-sgr' keeps
   * strict SGR color + allowlisted OSC 8 hyperlinks.
   */
  readonly allow?: 'none' | 'renderer-sgr' | undefined;
}

// renderer-sgr mode runs AFTER stripDangerousOsc (which already dropped every
// dangerous string sequence fail-closed and rebuilt allowed OSC 8 links in
// the canonical ESC-form frame). A single left-to-right scan then keeps ONLY:
//   - strict SGR: `ESC[` + params limited to digits/:/; + final `m` — the
//     same rule as ink's sanitize-ansi.ts sgrParametersRegex; a private
//     prefix like `ESC[>4;2m` (modifyOtherKeys) is NOT color, dropped whole;
//   - a canonical kept OSC 8 span (printable-ASCII body, ESC \ terminator).
// Every other CSI (ESC-form or C1 0x9b) is dropped WHOLE; any other ESC or
// control byte is caret-encoded. A bare ESC is NEVER emitted raw — a leaked
// ESC re-arms the terminal's parser against the text that follows it.
// Sticky (y) regexes anchor each attempt at the scanner's position.
// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[[\d:;]*m/y;
// eslint-disable-next-line no-control-regex
const OSC8_KEPT = /\x1b\]8;[\x20-\x7e]*\x1b\\/y;
// eslint-disable-next-line no-control-regex
const ANY_CSI = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/y;

function matchAt(re: RegExp, text: string, index: number): string | undefined {
  re.lastIndex = index;
  const m = re.exec(text);
  return m ? m[0] : undefined;
}

// Irreducible left-to-right control-byte scanner (SGR / kept-OSC-8 / CSI /
// caret-encode dispatch): a targeted complexity exception per §Z81 — a scan
// over a closed set of byte kinds is exhaustive, not "too complex".
// eslint-disable-next-line complexity
function sgrPassClean(text: string): string {
  if (!hasEscape(text)) return text; // fast path: no controls at all
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const code = ch.charCodeAt(0);
    if (code === 0x1b) {
      const kept = matchAt(SGR, text, i) ?? matchAt(OSC8_KEPT, text, i);
      if (kept !== undefined) {
        out += kept;
        i += kept.length;
        continue;
      }
      const csi = matchAt(ANY_CSI, text, i);
      if (csi !== undefined) {
        i += csi.length; // non-SGR CSI: dropped whole
        continue;
      }
      out += caretEncode(code); // bare/unknown ESC: visible marker
      i += 1;
      continue;
    }
    if (code === 0x9b) {
      const csi = matchAt(ANY_CSI, text, i);
      if (csi !== undefined) {
        i += csi.length; // C1 CSI: dropped whole (never spared)
        continue;
      }
      out += caretEncode(code);
      i += 1;
      continue;
    }
    if (
      (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f)
    ) {
      out += caretEncode(code);
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// Perf ceiling: the OSC/string-sequence regexes are O(n^2) worst case on
// adversarial multi-megabyte input with many unterminated introducers (each
// one triggers a fresh forward rescan). sanitizeStream() below is bounded by
// MAX_CARRY — callers with a large one-shot capture should prefer it over a
// single sanitize() call on the whole buffer.
export function sanitize(text: string, opts: SanitizeOptions = {}): string {
  const oscStripped = stripDangerousOsc(text);
  if (opts.allow === 'renderer-sgr') return sgrPassClean(oscStripped);
  return stripAnsi(oscStripped);
}

// stripHyperlinks re-exported for @minitui/renderer-ink (plan 13): strip the
// zero-width kept-OSC-8 frames before any manual column/wrap math (§X4).
export { ALLOWED_OSC8_SCHEMES, stripHyperlinks };
