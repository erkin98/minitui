// @minitui/sanitizer — ANSI/control-character chokepoint leaf (zero-dep).
// The single import every package routes untrusted text through before the screen.
import { caretEncode, hasEscape, stripAnsi } from './ansi.js';
import {
  stripDangerousOsc,
  ALLOWED_OSC8_SCHEMES,
  readControlString,
  stripHyperlinks,
  type OscLinkState,
} from './osc.js';

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

// Left-to-right control-byte scanner for SGR, kept OSC-8, CSI, and fallback
// caret encoding. The closed byte-kind dispatch is intentionally explicit.
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

export function sanitize(text: string, opts: SanitizeOptions = {}): string {
  return sanitizeWith(text, opts, { pending: undefined }, true);
}

// Shared body of sanitize(): strip dangerous OSC (threading the OSC 8 open/close
// pairing state so a stream can pair an open in one chunk with its close in the
// next — a fresh state cannot, which dropped the close and left an unmatched
// open that swallowed later text), then apply the mode's residual strip.
function sanitizeWith(
  text: string,
  opts: SanitizeOptions,
  oscState: OscLinkState,
  final: boolean,
): string {
  const oscStripped = stripDangerousOsc(text, oscState, final);
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
  // OSC 8 open/close pairing state, PERSISTENT across chunks: an open emitted in
  // one chunk and its close in the next now pair correctly (a per-chunk fresh
  // state dropped the close, leaving an unmatched open that swallowed later text).
  const oscState: OscLinkState = { pending: undefined };

  // Sequence completeness mirrors the osc.ts/ansi.ts grammar per family:
  //   - OSC (ESC ] / 0x9d): complete at ST (ESC \ or 0x9c) or BEL;
  //   - APC/DCS/PM/SOS (ESC _ P ^ X / 0x9f 0x90 0x9e 0x98): complete at ST
  //     ONLY — a BEL (or any letter) in their body is data, so they are held;
  //   - CSI (ESC [ / 0x9b): complete at a final byte 0x40-0x7e; a byte that
  //     can never appear in a CSI ends the hold (sanitize() handles the mess);
  //   - a lone trailing ESC: incomplete — hold it;
  //   - ESC escape: zero-or-more intermediates 0x20-0x2f then one final
  //     0x30-0x7e (held until the final arrives; zero intermediates = 2 bytes).
  // Returns the index just past the sequence, or -1 while incomplete.
  // eslint-disable-next-line complexity
  function sequenceEnd(buf: string, start: number): number {
    const first = buf.charCodeAt(start);
    const controlString = readControlString(buf, start);
    if (controlString !== undefined) return controlString.terminated ? controlString.end : -1;
    let kind: 'osc' | 'string' | 'csi';
    let bodyStart = start + 1;
    if (first === 0x1b) {
      const intro = buf[start + 1];
      if (intro === undefined) return -1; // lone trailing ESC
      if (intro === '[') kind = 'csi';
      else {
        // ESC escape (ECMA-48): zero-or-more intermediates 0x20-0x2f then one
        // final 0x30-0x7e. Hold (-1) if intermediates are seen but the final has
        // not arrived yet, so a chunk split mid-escape matches the one-shot
        // grammar (the old `return start + 2` assumed every non-CSI escape was
        // 2 bytes, splitting `ESC ( B` and diverging from one-shot output).
        const code = buf.charCodeAt(start + 1);
        if (code === 0x1b) return start + 1; // overlap: reconsider the second ESC
        // A C1 control after ESC (0x80-0x9f) is its OWN introducer (OSC/CSI/APC/
        // DCS/PM/SOS), not the final of a 2-byte ESC escape: hold the ESC and
        // reconsider the C1 so a chunk split between them matches one-shot output.
        if (code >= 0x80 && code <= 0x9f) return start + 1;
        if (code < 0x20 || code > 0x2f) return start + 2; // complete 2-byte escape
        let i = start + 2;
        while (i < buf.length && buf.charCodeAt(i) >= 0x20 && buf.charCodeAt(i) <= 0x2f) i++;
        return i >= buf.length ? -1 : i + 1;
      }
      bodyStart = start + 2;
    } else if (first === 0x9b) kind = 'csi';
    else return start + 1;
    if (kind === 'csi') {
      for (let i = bodyStart; i < buf.length; i++) {
        const c = buf.charCodeAt(i);
        if (c >= 0x40 && c <= 0x7e) return i + 1; // final byte
        if (c < 0x20 || c > 0x7e) return i; // malformed CSI: stop holding here
      }
      return -1;
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
        const cleaned = sanitizeWith(buf, opts, oscState, false); // unterminated span drops fail-closed
        if (cleaned) controller.enqueue(cleaned);
        return;
      }
      carry = hold;
      if (emit) {
        const cleaned = sanitizeWith(emit, opts, oscState, false);
        if (cleaned) controller.enqueue(cleaned);
      }
    },
    flush(controller) {
      const cleaned = sanitizeWith(carry, opts, oscState, true);
      if (cleaned) controller.enqueue(cleaned);
      carry = '';
    },
  });
}

// A spec/state nested past MAX_DEPTH is dropped to an inert null rather than
// recursing until stack exhaustion. Real catalog specs are far shallower.
const MAX_DEPTH = 256;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Deep, immutable string-prop clean for a spec object. The leaf cannot import
// AppSpec (zero-dep DAG rule), so this is generic over the runtime shape; the
// renderer/catalog call sites pass their concrete AppSpec and get it back.
function cleanValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return null;
  if (typeof value === 'string') return sanitize(value); // allow:'none'
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) return value.map((item) => cleanValue(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const cleanKey = sanitize(key); // allow:'none'
      if (RESERVED_KEYS.has(key) || RESERVED_KEYS.has(cleanKey)) {
        throw new TypeError('sanitized object contains a reserved key');
      }
      if (Object.hasOwn(out, cleanKey)) {
        throw new TypeError('sanitized object keys collide');
      }
      Object.defineProperty(out, cleanKey, {
        value: cleanValue((value as Record<string, unknown>)[key], depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value; // number, boolean, null, undefined, bigint, symbol — untouched
}

/**
 * Deep-clean a JSON-shaped value: every string value AND dynamic object key is
 * sanitized, arrays/objects are rebuilt immutably, and ambiguous or reserved
 * sanitized keys are rejected. Values beyond the nesting ceiling become null.
 * Callers pass validated JSON-shaped specs; the generic preserves that type
 * without introducing a dependency on the shared types package.
 */
export function sanitizeSpecStrings<S>(spec: S): S {
  return cleanValue(spec, 0) as S;
}

export { ALLOWED_OSC8_SCHEMES, stripHyperlinks };
