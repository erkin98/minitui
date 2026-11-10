// The frame width every harness and headless render uses: ink-testing-library's fake stdout reports 100
// columns and no rows, so frames grow without a height limit.
export const FROZEN_SIZE = Object.freeze({ columns: 100 } as const);

// The braille spinner glyphs a spinner cycles through; all of them collapse to one glyph.
export const SPINNER_FRAMES: readonly string[] = Object.freeze([
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
]);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const CLOCK_RE = /\b\d{2}:\d{2}:\d{2}\b/g;
const SPINNER_RE = new RegExp(`[${SPINNER_FRAMES.join('')}]`, 'g');

// Longest first, so a temporary directory under the home directory matches before the home itself.
function homePrefixes(): readonly string[] {
  const out: string[] = [];
  if (process.env.HOME) out.push(process.env.HOME);
  if (process.env.TMPDIR) out.push(process.env.TMPDIR.replace(/\/$/, ''));
  return out.sort((a, b) => b.length - a.length);
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A new string with every non-deterministic token frozen. The bare clock pattern needs a word boundary on
 * each side, so it never matches the time inside an ISO timestamp.
 */
export function stripAnsiNondeterminism(frame: string): string {
  let out = frame
    .replace(UUID_RE, '<uuid>')
    .replace(ISO_TS_RE, '<ts>')
    .replace(CLOCK_RE, '<time>')
    .replace(SPINNER_RE, '⠿');
  for (const home of homePrefixes()) {
    out = out.replace(new RegExp(escapeRe(home), 'g'), '<home>');
  }
  return out;
}
