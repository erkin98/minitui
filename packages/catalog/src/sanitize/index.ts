// Bind-time sanitize entry: re-export the zero-dep leaf so other catalog files
// route untrusted strings through one chokepoint. The strip impl lives in
// @minitui/sanitizer, never here.
import { sanitize, sanitizeSpecStrings } from '@minitui/sanitizer';
import { JsonValueSchema } from '@minitui/types';

export { sanitize, sanitizeSpecStrings } from '@minitui/sanitizer';

// The longest issue text, in UTF-16 code units: a message, and an element key or offending name.
const MESSAGE_CAP = 300;
const NAME_CAP = 80;
const ELLIPSIS = '…';

// Cleaned of terminal controls, then cut to `cap` code units with the ellipsis counted inside the cap.
// The cut never leaves half of a surrogate pair.
function cleanAndCut(text: string, cap: number): string {
  const clean = sanitize(text);
  if (clean.length <= cap) return clean;
  let end = cap - ELLIPSIS.length;
  const last = clean.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${clean.slice(0, end)}${ELLIPSIS}`;
}

/**
 * An issue with its model-authored text made safe to print and to send back: `message`, `elementKey`
 * and, when it is a string, `offending` are cleaned and cut. Applied once at the exit of each gate
 * function, never at the individual issue sites. Short clean text comes back unchanged.
 */
export function boundIssue<
  T extends { readonly message: string; readonly elementKey: string; readonly offending?: string },
>(issue: T): T {
  return {
    ...issue,
    message: cleanAndCut(issue.message, MESSAGE_CAP),
    elementKey: cleanAndCut(issue.elementKey, NAME_CAP),
    ...(typeof issue.offending === 'string'
      ? { offending: cleanAndCut(issue.offending, NAME_CAP) }
      : {}),
  };
}

// Whether the object keys at two corresponding nodes are the same, in the same order, at every level.
function sameKeys(original: unknown, cleaned: unknown): boolean {
  const pending: Array<readonly [unknown, unknown]> = [[original, cleaned]];
  for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
    const [a, b] = pair;
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      a.forEach((item, index) => pending.push([item, b[index]]));
    } else if (typeof a === 'object' && a !== null) {
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return false;
      const keys = Object.keys(a);
      const cleanedKeys = Object.keys(b);
      if (keys.length !== cleanedKeys.length || keys.some((key, i) => key !== cleanedKeys[i])) {
        return false;
      }
      const left = a as Record<string, unknown>;
      const right = b as Record<string, unknown>;
      for (const key of keys) pending.push([left[key], right[key]]);
    }
  }
  return true;
}

/**
 * True when `value` is a plain JSON tree (no cycle, no shared reference, within the shared depth and
 * size limits, no reserved key) whose every object key the spec sanitiser leaves unchanged. Never
 * throws; bounded.
 */
export function hasCanonicalKeys(value: unknown): boolean {
  try {
    if (!JsonValueSchema.safeParse(value).success) return false;
    // The sanitiser is reached only after the JSON-tree screen above has passed: it is exponential on a
    // shared-reference graph, and the screen refuses one.
    return sameKeys(value, sanitizeSpecStrings(value));
  } catch {
    return false;
  }
}
