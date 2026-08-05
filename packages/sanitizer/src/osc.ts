// OSC / APC / DCS / PM / SOS handling. These string-parameter sequences carry
// the dangerous side-effecting payloads (clipboard write, file write,
// graphics), so they are excised as WHOLE spans — ESC-form AND C1-form
// introducers alike. Grammar mirrors ink's reference tokenizer
// (its src/ansi-tokenizer.ts):
//   - introducers: OSC ESC]/0x9d, DCS ESC P/0x90, PM ESC^/0x9e,
//     APC ESC_/0x9f, SOS ESC X/0x98;
//   - String Terminator is ESC \ or the C1 ST 0x9c; BEL (0x07) additionally
//     terminates OSC ONLY — inside DCS/PM/APC/SOS a BEL is payload data;
//   - FAIL CLOSED: an UNTERMINATED sequence is dropped from its introducer to
//     end of input (ink emits one `invalid` token and drops it). A leaked live
//     introducer would put the real terminal into string-collect mode and
//     swallow everything printed after us into the attacker's payload.
// We:
//   - DROP OSC 52 (clipboard), OSC 1337 (iTerm file), and all APC/DCS/PM/SOS.
//   - ALLOWLIST OSC 8 hyperlink schemes; a kept link is REBUILT canonically
//     from its parsed printable-ASCII body (never raw input bytes); any other
//     scheme loses its wrapper but keeps the human-visible link text.
//   - STRIP bracketed-paste markers (CSI 200~ / 201~) as defense-in-depth:
//     inert in already-captured output, but they must not survive if output
//     is ever piped to an interactive stdin.

function readonlySet<T>(values: readonly T[]): ReadonlySet<T> {
  const backing = new Set(values);
  const facade: ReadonlySet<T> = {
    get size() {
      return backing.size;
    },
    has(value) {
      return backing.has(value);
    },
    entries() {
      return backing.entries();
    },
    keys() {
      return backing.keys();
    },
    values() {
      return backing.values();
    },
    forEach(callback, thisArg) {
      for (const value of backing) callback.call(thisArg, value, value, facade);
    },
    [Symbol.iterator]() {
      return backing[Symbol.iterator]();
    },
  };
  return Object.freeze(facade);
}

export const ALLOWED_OSC8_SCHEMES: ReadonlySet<string> = readonlySet([
  'https',
  'http',
  'file',
  'mailto',
]);

// A kept OSC 8 span may contain ONLY printable ASCII between its frame bytes.
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const MAX_PENDING_LABEL = 8192;
const OSC8_CLOSE = '\x1b]8;;\x1b\\';

export type ControlStringFamily = 'osc' | 'string';

export interface ControlStringSpan {
  readonly family: ControlStringFamily;
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly end: number;
  readonly terminated: boolean;
}

function familyAt(
  text: string,
  start: number,
): { family: ControlStringFamily; bodyStart: number } | undefined {
  const first = text.charCodeAt(start);
  if (first === 0x1b) {
    const intro = text[start + 1];
    if (intro === ']') return { family: 'osc', bodyStart: start + 2 };
    if (intro === '_' || intro === 'P' || intro === '^' || intro === 'X') {
      return { family: 'string', bodyStart: start + 2 };
    }
    return undefined;
  }
  if (first === 0x9d) return { family: 'osc', bodyStart: start + 1 };
  if (first === 0x90 || first === 0x98 || first === 0x9e || first === 0x9f) {
    return { family: 'string', bodyStart: start + 1 };
  }
  return undefined;
}

export function readControlString(text: string, start: number): ControlStringSpan | undefined {
  const intro = familyAt(text, start);
  if (intro === undefined) return undefined;
  let i = intro.bodyStart;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0x9c || (code === 0x07 && intro.family === 'osc')) {
      return {
        family: intro.family,
        bodyStart: intro.bodyStart,
        bodyEnd: i,
        end: i + 1,
        terminated: true,
      };
    }
    if (code === 0x1b) {
      if (text.charCodeAt(i + 1) === 0x1b) {
        i += 2;
        continue;
      }
      if (text[i + 1] === '\\') {
        return {
          family: intro.family,
          bodyStart: intro.bodyStart,
          bodyEnd: i,
          end: i + 2,
          terminated: true,
        };
      }
    }
    i++;
  }
  return {
    family: intro.family,
    bodyStart: intro.bodyStart,
    bodyEnd: text.length,
    end: text.length,
    terminated: false,
  };
}

export function stripControlStrings(text: string): string {
  let out = '';
  let cursor = 0;
  let i = 0;
  while (i < text.length) {
    const span = readControlString(text, i);
    if (span === undefined) {
      i++;
      continue;
    }
    out += text.slice(cursor, i);
    if (!span.terminated) return out;
    i = span.end;
    cursor = i;
  }
  return out + text.slice(cursor);
}

function schemeOf(uri: string): string {
  const colon = uri.indexOf(':');
  return colon === -1 ? '' : uri.slice(0, colon).toLowerCase();
}

interface PendingLabelPart {
  readonly value: string;
  readonly previous: PendingLabelPart | undefined;
}

interface PendingLink {
  readonly frame: string;
  readonly label: PendingLabelPart | undefined;
  readonly labelLength: number;
}

export interface OscLinkState {
  pending: PendingLink | undefined;
}

export type OscSegment =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'trusted-osc8'; readonly value: string };

function appendText(out: OscSegment[], text: string): void {
  if (text.length > 0) out.push({ kind: 'text', value: text });
}

function appendPendingLabel(out: OscSegment[], pending: PendingLink): void {
  const reversed: string[] = [];
  let part = pending.label;
  while (part !== undefined) {
    reversed.push(part.value);
    part = part.previous;
  }
  for (let index = reversed.length - 1; index >= 0; index--) appendText(out, reversed[index]!);
}

function appendVisible(state: OscLinkState, out: OscSegment[], text: string): void {
  if (text.length === 0) return;
  const pending = state.pending;
  if (pending === undefined) {
    appendText(out, text);
    return;
  }
  if (pending.labelLength + text.length <= MAX_PENDING_LABEL) {
    state.pending = {
      ...pending,
      label: { value: text, previous: pending.label },
      labelLength: pending.labelLength + text.length,
    };
    return;
  }
  appendPendingLabel(out, pending);
  appendText(out, text);
  state.pending = undefined;
}

function handleOsc(body: string, state: OscLinkState, out: OscSegment[]): void {
  const separator = body.indexOf(';');
  if (separator === -1 || body.slice(0, separator) !== '8') return;
  const linkBody = body.slice(separator + 1);
  const uriSeparator = linkBody.indexOf(';');
  if (uriSeparator === -1) return;
  const uri = linkBody.slice(uriSeparator + 1);
  if (uri === '') {
    const pending = state.pending;
    state.pending = undefined;
    if (pending !== undefined) {
      out.push({ kind: 'trusted-osc8', value: pending.frame });
      appendPendingLabel(out, pending);
      out.push({ kind: 'trusted-osc8', value: OSC8_CLOSE });
    }
    return;
  }
  if (!PRINTABLE_ASCII.test(linkBody) || !ALLOWED_OSC8_SCHEMES.has(schemeOf(uri))) {
    return;
  }
  const previous = state.pending;
  if (previous !== undefined) appendPendingLabel(out, previous);
  state.pending = {
    frame: `\x1b]8;${linkBody}\x1b\\`,
    label: undefined,
    labelLength: 0,
  };
}

function pasteMarkerLength(text: string, index: number): number {
  if (text.startsWith('\x1b[200~', index) || text.startsWith('\x1b[201~', index)) return 6;
  if (text.startsWith('\x9b200~', index) || text.startsWith('\x9b201~', index)) return 5;
  return 0;
}

export function stripDangerousOscSegments(
  text: string,
  state: OscLinkState = { pending: undefined },
  final = true,
): OscSegment[] {
  const out: OscSegment[] = [];
  let cursor = 0;
  let i = 0;
  while (i < text.length) {
    const markerLength = pasteMarkerLength(text, i);
    if (markerLength > 0) {
      appendVisible(state, out, text.slice(cursor, i));
      i += markerLength;
      cursor = i;
      continue;
    }
    const span = readControlString(text, i);
    if (span === undefined) {
      i++;
      continue;
    }
    appendVisible(state, out, text.slice(cursor, i));
    if (!span.terminated) {
      cursor = text.length;
      break;
    }
    if (span.family === 'osc') {
      handleOsc(text.slice(span.bodyStart, span.bodyEnd), state, out);
    }
    i = span.end;
    cursor = i;
  }
  appendVisible(state, out, text.slice(cursor));
  if (final && state.pending !== undefined) {
    appendPendingLabel(out, state.pending);
    state.pending = undefined;
  }
  return out;
}

export function stripDangerousOsc(
  text: string,
  state: OscLinkState = { pending: undefined },
  final = true,
): string {
  return stripDangerousOscSegments(text, state, final)
    .map((segment) => segment.value)
    .join('');
}

// Canonical OSC 8 frames occupy zero display columns, but naive counters include
// their ASCII URL payload. Remove only the frame emitted by renderer-sgr before
// measuring width; leave SGR and all other sanitized text untouched.
// eslint-disable-next-line no-control-regex
const OSC8_LINK = /\x1b\]8;[\x20-\x7e]*\x1b\\/g;

export function stripHyperlinks(text: string): string {
  if (!text.includes('\x1b')) return text; // fast path: no escape frames
  return text.replace(OSC8_LINK, '');
}
