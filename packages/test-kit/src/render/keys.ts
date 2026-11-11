// Named raw-stdin escape sequences: the exact bytes a terminal sends for each key. ink-testing-library's
// stdin.write() takes them and Ink's useInput decodes them. Frozen, so a test can never change the table.
// \x1b is ESC (the CSI prefix), \x7f is DEL (backspace), \x03 is Ctrl-C (ETX).
export const KEYS = Object.freeze({
  enter: '\r',
  escape: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  tab: '\t',
  shiftTab: '\x1b[Z',
  backspace: '\x7f',
  delete: '\x1b[3~',
  space: ' ',
  ctrlC: '\x03',
} as const);

export type KeyName = keyof typeof KEYS;

// Own keys only: a name inherited from Object.prototype ('toString') is not a key name.
const isKeyName = (key: string): key is KeyName => Object.hasOwn(KEYS, key);

/** A named key becomes its bytes; any other text (a raw escape sequence) passes through unchanged. */
export function keyBytes(key: string): string {
  return isKeyName(key) ? KEYS[key] : key;
}
