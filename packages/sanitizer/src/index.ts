// @minitui/sanitizer — ANSI/control-character chokepoint leaf (zero-dep).
// The single import every package routes untrusted text through before the screen.
import { caretEncode, CSI_SEQUENCE_SOURCE, hasEscape, stripAnsi } from './ansi.js';
import {
  stripDangerousOscSegments,
  ALLOWED_OSC8_SCHEMES,
  stripHyperlinks,
  type OscLinkState,
} from './osc.js';
// Stream completeness grammar. NOT re-exported from this barrel — test/surface.test.ts
// freezes the public surface at six names, and both growth and shrink must red.
import { splitTail } from './stream-grammar.js';

export interface SanitizeOptions {
  /**
   * 'none' (default) strips all escapes incl. SGR; 'renderer-sgr' keeps
   * strict SGR color + allowlisted OSC 8 hyperlinks.
   */
  readonly allow?: 'none' | 'renderer-sgr' | undefined;
}

// renderer-sgr mode runs AFTER stripDangerousOscSegments (which already dropped every
// dangerous string sequence fail-closed and rebuilt allowed OSC 8 links in
// the canonical ESC-form frame). A single left-to-right scan then keeps ONLY:
//   - strict SGR: `ESC[` + params limited to digits/:/; + final `m` — the
//     same rule as ink's sanitize-ansi.ts sgrParametersRegex; a private
//     prefix like `ESC[>4;2m` (modifyOtherKeys) is NOT color, dropped whole;
// Every other CSI (ESC-form or C1 0x9b) is dropped WHOLE; any other ESC or
// control byte is caret-encoded. A bare ESC is NEVER emitted raw — a leaked
// ESC re-arms the terminal's parser against the text that follows it.
// Sticky (y) regexes anchor each attempt at the scanner's position.
// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[[\d:;]*m/y;
// Built from ansi.ts's single grammar source, not a second spelling of it.
const ANY_CSI = new RegExp(CSI_SEQUENCE_SOURCE, 'y');

function matchAt(re: RegExp, text: string, index: number): string | undefined {
  re.lastIndex = index;
  const m = re.exec(text);
  return m ? m[0] : undefined;
}

// Left-to-right control-byte scanner for SGR, kept OSC-8, CSI, and fallback
// caret encoding. The closed byte-kind dispatch is intentionally explicit.
function sgrPassClean(text: string): string {
  if (!hasEscape(text)) return text; // fast path: no controls at all
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const code = ch.charCodeAt(0);
    if (code === 0x1b) {
      const kept = matchAt(SGR, text, i);
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
  if (oscState.pending === undefined && !hasEscape(text)) return text;
  const segments = stripDangerousOscSegments(text, oscState, final);
  if (opts.allow === 'renderer-sgr') {
    return segments
      .map((segment) =>
        segment.kind === 'trusted-osc8' ? segment.value : sgrPassClean(segment.value),
      )
      .join('');
  }
  return segments
    .filter((segment) => segment.kind === 'text')
    .map((segment) => stripAnsi(segment.value))
    .join('');
}

// Where a chunk may have cut an escape sequence in half, hold back from the
// FIRST unterminated sequence in the buffer and prepend it to the next chunk.
// When sequences are adjacent — one ending exactly on the next introducer — the
// hold starts at the beginning of the CURRENT adjacency chain, so a cut inside
// the run carries the whole run. It does NOT start at the first chain in the
// buffer: a chain that closed on a plain byte is finished, and holding from it
// would inflate a few-byte tail into a buffer-long hold that trips the cap.
// Never hold from `lastIndexOf(ESC)`: an unterminated OSC's payload can
// itself contain later ESC bytes, and holding only from the last one would
// emit the live introducer ahead of it. At flush, the held tail is sanitized
// — stripDangerousOscSegments drops an unterminated string sequence fail-closed, and
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
