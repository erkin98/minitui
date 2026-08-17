// Stream completeness grammar: given a buffer, where does an escape sequence
// end, and how much of the tail must be held back for the next chunk. Split out
// of the sanitizeStream factory so each rule can be asserted directly instead of
// only through full-stream round trips — none of these helpers ever closed over
// the stream's carry, OSC state or options, so the nesting bought nothing.
import { readControlString } from './osc.js';

// ESC escape (ECMA-48): zero-or-more intermediates 0x20-0x2f then one final
// 0x30-0x7e. Hold (-1) if intermediates are seen but the final has not arrived
// yet, so a chunk split mid-escape matches the one-shot grammar (the old
// `return start + 2` assumed every non-CSI escape was 2 bytes, splitting
// `ESC ( B` and diverging from one-shot output).
export function escEscapeEnd(buf: string, start: number): number {
  const code = buf.charCodeAt(start + 1);
  if (code === 0x1b) return start + 1; // overlap: reconsider the second ESC
  // A C1 control after ESC (0x80-0x9f) is its OWN introducer (OSC/CSI/APC/
  // DCS/PM/SOS), not the final of a 2-byte ESC escape: hold the ESC and
  // reconsider the C1 so a chunk split between them matches one-shot output.
  if (code >= 0x80 && code <= 0x9f) return start + 1;
  if (code >= 0x20 && code <= 0x2f) {
    let i = start + 2;
    while (i < buf.length && buf.charCodeAt(i) >= 0x20 && buf.charCodeAt(i) <= 0x2f) i++;
    if (i >= buf.length) return -1;
    const final = buf.charCodeAt(i);
    return final >= 0x30 && final <= 0x7e ? i + 1 : i;
  }
  if (code >= 0x30 && code <= 0x7e) return start + 2; // complete 2-byte escape
  return start + 1; // malformed: reconsider the byte after ESC
}

// CSI body scan from just past the introducer: complete at a final byte
// 0x40-0x7e; a byte that can never appear in a CSI ends the hold at its own
// index (sanitize() handles the mess); -1 while the buffer runs out first.
// Order is enforced, not just membership — ansi.ts's CSI_SEQUENCE_SOURCE reads
// parameters (0x30-0x3f) then intermediates (0x20-0x2f), so a parameter AFTER
// an intermediate is malformed and takes the same exit. Accepting it here made
// this the third and LOOSEST spelling of one grammar, and one grammar
// disagreeing with another is exactly what caused the `ESC ; Z` content loss.
export function csiEnd(buf: string, bodyStart: number): number {
  let seenIntermediate = false;
  for (let i = bodyStart; i < buf.length; i++) {
    const c = buf.charCodeAt(i);
    if (c >= 0x40 && c <= 0x7e) return i + 1; // final byte
    if (c < 0x20 || c > 0x7e) return i; // malformed CSI: stop holding here
    if (c <= 0x2f) seenIntermediate = true;
    else if (seenIntermediate) return i; // parameter after an intermediate
  }
  return -1;
}

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
export function sequenceEnd(buf: string, start: number): number {
  const first = buf.charCodeAt(start);
  const controlString = readControlString(buf, start);
  if (controlString !== undefined) return controlString.terminated ? controlString.end : -1;
  if (first === 0x1b) {
    const intro = buf[start + 1];
    if (intro === undefined) return -1; // lone trailing ESC
    return intro === '[' ? csiEnd(buf, start + 2) : escEscapeEnd(buf, start);
  }
  if (first === 0x9b) return csiEnd(buf, start + 1);
  return start + 1;
}

export function isIntroducer(code: number): boolean {
  return (
    code === 0x1b ||
    code === 0x90 ||
    code === 0x98 ||
    code === 0x9b ||
    (code >= 0x9d && code <= 0x9f)
  );
}

export function splitTail(buf: string): { emit: string; hold: string } {
  let i = 0;
  let prefixStart: number | undefined;
  while (i < buf.length) {
    if (!isIntroducer(buf.charCodeAt(i))) {
      i += 1;
      continue;
    }
    const end = sequenceEnd(buf, i);
    if (end === -1) {
      const holdStart = prefixStart ?? i;
      return { emit: buf.slice(0, holdStart), hold: buf.slice(holdStart) };
    }
    if (end < buf.length && isIntroducer(buf.charCodeAt(end))) {
      prefixStart ??= i;
    } else {
      // The chain is over: this sequence did not end on another introducer, so
      // a later unterminated sequence must hold from ITSELF, not from a chain
      // that closed earlier in the buffer. Latching here made the hold span the
      // whole buffer, tripping MAX_CARRY on a sequence only a few bytes long.
      prefixStart = undefined;
    }
    i = end;
  }
  return { emit: buf, hold: '' };
}
