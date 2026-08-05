/**
 * ink's ECMA-48 byte classes, VENDORED BY HAND from its `src/ansi-tokenizer.ts`.
 *
 * This is a copy on purpose. `@minitui/sanitizer` is a DAG leaf and only
 * `renderer-ink` and `cli` may import ink at all (the renderer-swap boundary in
 * AGENTS.md), so a test here that imported ink's tokenizer to diff against would
 * breach the invariant it is trying to protect — and would add a runtime
 * dependency to a zero-dependency package's test tree.
 *
 * The copy is what `ink-grammar-drift.test.ts` diffs our grammar against. It
 * catches the direction that actually bites: our own byte classes drifting away
 * from the reference. It cannot catch ink changing upstream — that needs a human
 * re-reading the tokenizer — so treat these values as a pinned reference, and
 * when you update them, update them from the source and say so.
 */

/** Inclusive `[low, high]` code-point ranges, one per named class. */
export const INK_BYTE_CLASSES = {
  /** isCsiParameterCharacter */
  csiParameter: [0x30, 0x3f],
  /** isCsiIntermediateCharacter */
  csiIntermediate: [0x20, 0x2f],
  /** isCsiFinalCharacter */
  csiFinal: [0x40, 0x7e],
  /** isEscapeIntermediateCharacter */
  escapeIntermediate: [0x20, 0x2f],
  /** isEscapeFinalCharacter */
  escapeFinal: [0x30, 0x7e],
  /**
   * isC1ControlCharacter.
   *
   * NOT independently witnessed by the drift sweep, unlike every other entry
   * here. `escEscapeEnd` returns the same `start + 1` for a C1 byte after ESC
   * (it is its own introducer) as it does for a malformed one (reconsider the
   * next byte), so narrowing this range changes no expected value and cannot
   * red the gate — verified by mutating both bounds. It is kept because it is
   * genuinely part of the reference and computing the escape expectation
   * without it would be a second hardcoded copy; do not read its presence here
   * as a claim that it is gated. The C1 introducers specifically ARE gated,
   * through INK_INTRODUCERS.
   */
  c1Control: [0x80, 0x9f],
} as const satisfies Record<string, readonly [number, number]>;

/** Sequence introducers: escapeCharacter and the C1 introducer constants. */
export const INK_INTRODUCERS = {
  escape: 0x1b,
  csi: 0x9b,
  osc: 0x9d,
  dcs: 0x90,
  pm: 0x9e,
  apc: 0x9f,
  sos: 0x98,
} as const;

/** bellCharacter and stringTerminatorCharacter. */
export const INK_TERMINATORS = { bell: 0x07, stringTerminator: 0x9c } as const;

export function inClass(code: number, name: keyof typeof INK_BYTE_CLASSES): boolean {
  const [low, high] = INK_BYTE_CLASSES[name];
  return code >= low && code <= high;
}
