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

// Where a chunk may have cut an escape sequence in half, hold back from the
// FIRST unterminated sequence in the buffer and prepend it to the next chunk.
// Never hold from `lastIndexOf(ESC)`: an unterminated OSC's payload can
// itself contain later ESC bytes, and holding only from the last one would
// emit the live introducer ahead of it. At flush, the held tail is sanitized
// — stripDangerousOsc drops an unterminated string sequence fail-closed, and
// a dangling lone ESC is caret-encoded, never silently dropped.
//
// The carry is CAPPED so a never-terminating sequence cannot buffer
// unboundedly: past MAX_CARRY the whole buffer is sanitized and flushed (the
// unterminated span drops fail-closed; if the sequence would have terminated
// later, its remaining payload arrives as inert visible text — bounded
// memory and no live bytes, at the cost of junk on a >8 KiB sequence).
const MAX_CARRY = 8192;

export function sanitizeStream(opts: SanitizeOptions = {}): TransformStream<string, string> {
  let carry = '';

  // Sequence completeness mirrors the osc.ts/ansi.ts grammar per family:
  //   - OSC (ESC ] / 0x9d): complete at ST (ESC \ or 0x9c) or BEL;
  //   - APC/DCS/PM/SOS (ESC _ P ^ X / 0x9f 0x90 0x9e 0x98): complete at ST
  //     ONLY — a BEL (or any letter) in their body is data, so they are held;
  //   - CSI (ESC [ / 0x9b): complete at a final byte 0x40-0x7e; a byte that
  //     can never appear in a CSI ends the hold (sanitize() handles the mess);
  //   - a lone trailing ESC: incomplete — hold it;
  //   - ESC + any other byte: a complete 2-byte escape.
  // Returns the index just past the sequence, or -1 while incomplete.
  // eslint-disable-next-line complexity
  function sequenceEnd(buf: string, start: number): number {
    const first = buf.charCodeAt(start);
    let kind: 'osc' | 'string' | 'csi';
    let bodyStart = start + 1;
    if (first === 0x1b) {
      const intro = buf[start + 1];
      if (intro === undefined) return -1; // lone trailing ESC
      if (intro === ']') kind = 'osc';
      else if (intro === '_' || intro === 'P' || intro === '^' || intro === 'X') kind = 'string';
      else if (intro === '[') kind = 'csi';
      else return start + 2; // complete 2-byte escape
      bodyStart = start + 2;
    } else if (first === 0x9d) kind = 'osc';
    else if (first === 0x9b) kind = 'csi';
    else kind = 'string'; // 0x90 / 0x98 / 0x9e / 0x9f
    if (kind === 'csi') {
      for (let i = bodyStart; i < buf.length; i++) {
        const c = buf.charCodeAt(i);
        if (c >= 0x40 && c <= 0x7e) return i + 1; // final byte
        if (c < 0x20 || c > 0x7e) return i; // malformed CSI: stop holding here
      }
      return -1;
    }
    for (let i = bodyStart; i < buf.length; i++) {
      const c = buf.charCodeAt(i);
      if (c === 0x9c) return i + 1; // C1 ST
      if (c === 0x07 && kind === 'osc') return i + 1; // BEL terminates OSC only
      if (c === 0x1b && buf[i + 1] === '\\') return i + 2; // ESC \
    }
    return -1;
  }

  function isIntroducer(code: number): boolean {
    return (
      code === 0x1b ||
      code === 0x90 ||
      code === 0x98 ||
      code === 0x9b ||
      (code >= 0x9d && code <= 0x9f)
    );
  }

  function splitTail(buf: string): { emit: string; hold: string } {
    let i = 0;
    while (i < buf.length) {
      if (!isIntroducer(buf.charCodeAt(i))) {
        i += 1;
        continue;
      }
      const end = sequenceEnd(buf, i);
      if (end === -1) return { emit: buf.slice(0, i), hold: buf.slice(i) };
      i = end;
    }
    return { emit: buf, hold: '' };
  }

  return new TransformStream<string, string>({
    transform(chunk, controller) {
      const buf = carry + chunk;
      const { emit, hold } = splitTail(buf);
      if (hold.length > MAX_CARRY) {
        carry = '';
        const cleaned = sanitize(buf, opts); // unterminated span drops fail-closed
        if (cleaned) controller.enqueue(cleaned);
        return;
      }
      carry = hold;
      if (emit) controller.enqueue(sanitize(emit, opts));
    },
    flush(controller) {
      if (carry) controller.enqueue(sanitize(carry, opts));
      carry = '';
    },
  });
}

// stripHyperlinks re-exported for @minitui/renderer-ink (plan 13): strip the
// zero-width kept-OSC-8 frames before any manual column/wrap math (§X4).
export { ALLOWED_OSC8_SCHEMES, stripHyperlinks };
