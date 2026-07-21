// OSC / APC / DCS / PM / SOS handling. These string-parameter sequences carry
// the dangerous side-effecting payloads (clipboard write, file write,
// graphics), so they are excised as WHOLE spans — ESC-form AND C1-form
// introducers alike. Grammar mirrors ink's reference tokenizer
// (repos/ink/src/ansi-tokenizer.ts):
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

// A ReadonlySet whose RUNTIME is actually immutable. `Object.freeze` alone does
// NOT stop `Set.prototype.add`/`delete`/`clear` — those mutate internal slots,
// not object properties — so the exported allowlist would be a live Set any
// in-process caller could `.add('javascript')` to, permanently weakening OSC 8
// scheme enforcement for every later sanitize(). The mutators are overridden to
// throw, then the object is frozen.
function frozenSet<T>(values: readonly T[]): ReadonlySet<T> {
  const set = new Set(values);
  const reject = (): never => {
    throw new TypeError('ALLOWED_OSC8_SCHEMES is a frozen allowlist');
  };
  return Object.freeze(
    Object.defineProperties(set, {
      add: { value: reject },
      delete: { value: reject },
      clear: { value: reject },
    }),
  );
}

export const ALLOWED_OSC8_SCHEMES: ReadonlySet<string> = frozenSet([
  'https',
  'http',
  'file',
  'mailto',
]);

// String Terminator: ESC \ or the 8-bit C1 ST (0x9c).
const ST = '(?:\\x1b\\\\|\\x9c)';

// Control-string body: any bytes, non-greedy — but a doubled ESC (ESC ESC) is a
// tmux-escaped literal ESC in the payload, NOT the start of an ST, so the pair
// is consumed as one unit and the terminator search does not stop one byte
// early (mirrors ink's findControlStringTerminatorIndex doubled-ESC skip). Under
// the buggy `[\s\S]*?` a doubled ESC's second byte + a following `\` was misread
// as the ST, under-consuming the sequence and leaking the rest of its payload.
const BODY = '(?:\\x1b\\x1b|[\\s\\S])*?';

// OSC ( ESC ] or C1 0x9d ). First alternative: capture command + body up to
// the nearest ST/BEL. Second alternative (command/body undefined): NO
// terminator anywhere ahead — consume to end of input (fail closed).
const OSC = new RegExp(`(?:\\x1b\\]|\\x9d)(?:([0-9]*);?(${BODY})(?:${ST}|\\x07)|[\\s\\S]*$)`, 'g');

// APC / DCS / PM / SOS — both introducer forms; whole payload up to ST ONLY
// (BEL is data here), or to end of input when unterminated (fail closed).
const STRING_SEQ = new RegExp(
  `(?:\\x1b[_P^X]|[\\x90\\x98\\x9e\\x9f])(?:${BODY}${ST}|[\\s\\S]*$)`,
  'g',
);

// Bracketed-paste begin/end markers (ESC-form and C1 CSI form).
// eslint-disable-next-line no-control-regex
const PASTE_MARKERS = /(?:\x1b\[|\x9b)20[01]~/g;

// Any introducer byte this module owns: ESC, DCS, SOS, C1 CSI, OSC, PM, APC.
// eslint-disable-next-line no-control-regex
const HAS_INTRODUCER = /[\x1b\x90\x98\x9b\x9d-\x9f]/;

// A kept OSC 8 span may contain ONLY printable ASCII between its frame bytes.
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

function schemeOf(uri: string): string {
  const colon = uri.indexOf(':');
  return colon === -1 ? '' : uri.slice(0, colon).toLowerCase();
}

// An OSC 8 hyperlink arrives as TWO separate matches — the open
// `ESC]8;params;URI ST` and the close `ESC]8;; ST` (empty URI). A stateless
// handler cannot tell an allowed link's close from a disallowed link's close,
// so each replace pass uses one fresh closure that remembers whether the open
// it last saw was an allowed link we kept. Result:
//   - allowed scheme + printable-ASCII body: open AND close re-emitted in the
//     CANONICAL ESC-form frame (rebuilt from parsed parts — a C1-framed or
//     BEL-terminated allowed link normalizes, and a body smuggling control
//     bytes fails the printable check and loses its wrapper);
//   - disallowed/unknown scheme: open AND close dropped, visible text kept;
//   - OSC 52 / 1337 / other commands, and any UNTERMINATED OSC (undefined
//     command from the to-end alternative): dropped wholesale.
// replace() never rescans its own replacements, so a rebuilt kept link cannot
// be re-matched by this or a later pass in the same call.
// The pairing state lives in a caller-owned `OscLinkState` so it can be THREADED
// across separate stripDangerousOsc() calls — a streaming chunk boundary, or an
// intervening dropped OSC 52 between an open and its close, no longer resets it.
// A one-shot sanitize() passes a fresh state, so it stays pure.
export interface OscLinkState {
  keeping: boolean;
}

function makeOscHandler(
  state: OscLinkState,
): (full: string, command: string | undefined, body: string | undefined) => string {
  return function handleOsc(full, command, body) {
    if (command === undefined || body === undefined) {
      return ''; // unterminated OSC: fail closed (not an OSC 8 pair — state untouched)
    }
    if (command === '8') {
      const semi = body.indexOf(';');
      const uri = semi === -1 ? '' : body.slice(semi + 1);
      if (uri === '') {
        const keep = state.keeping; // close: keep iff its open was kept
        state.keeping = false;
        return keep ? '\x1b]8;;\x1b\\' : '';
      }
      if (PRINTABLE_ASCII.test(body) && ALLOWED_OSC8_SCHEMES.has(schemeOf(uri))) {
        state.keeping = true; // allowed: rebuild the canonical open
        return `\x1b]8;${body}\x1b\\`;
      }
      state.keeping = false;
      return ''; // disallowed scheme: drop wrapper, keep text
    }
    // OSC 52 (clipboard), OSC 1337 (iTerm file), and every other OSC: drop — but
    // only an OSC 8 open/close touches the pairing state, so a dropped OSC 52
    // between an open and its close must NOT orphan the open by clearing it.
    return '';
  };
}

export function stripDangerousOsc(text: string, state: OscLinkState = { keeping: false }): string {
  if (!HAS_INTRODUCER.test(text)) return text; // fast path
  return text
    .replace(STRING_SEQ, '')
    .replace(OSC, makeOscHandler(state))
    .replace(PASTE_MARKERS, '');
}

// WIDTH helper — NOT part of the strip pipeline. A KEPT OSC 8 hyperlink is
// emitted by the renderer-sgr path in the canonical form `ESC ] 8 ; <body>
// ESC \` and occupies ZERO display columns, but its printable-ASCII body
// (scheme + URL) is counted as visible width by a naive column count, so
// wrap/truncate/alignment math on that output silently breaks. Strip the
// frames BEFORE measuring width. Mirrors codex custom_terminal.rs:57
// display_width (which strips OSC before UnicodeWidthStr::width); codex
// handles only the BEL form, so minitui keeps this next to the grammar that
// EMITTED the ST-form frame rather than copying a width function. SGR is left
// intact — it is zero-width and every width counter already drops it; this
// helper's sole job is the hyperlink frames. Matches ONLY the canonical form
// this leaf produces, so it never eats anything a caller did not sanitize.
// eslint-disable-next-line no-control-regex
const OSC8_LINK = /\x1b\]8;[\x20-\x7e]*\x1b\\/g;

export function stripHyperlinks(text: string): string {
  if (!text.includes('\x1b')) return text; // fast path: no escape frames
  return text.replace(OSC8_LINK, '');
}
