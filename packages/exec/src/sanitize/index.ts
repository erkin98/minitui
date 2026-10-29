/**
 * Thin re-export of the @minitui/sanitizer leaf. The strip/caret-encode impl lives THERE,
 * never here — exec depends on sanitizer, never the reverse (security invariant).
 * Re-exports ONLY what exec consumes (sanitize/sanitizeStream); sanitizeSpecStrings is
 * AppSpec-typed and belongs to renderer-ink/catalog, not exec.
 */
export { sanitize, sanitizeStream } from '@minitui/sanitizer';

import { sanitize } from '@minitui/sanitizer';

/** Public exec alias (the barrel's sanitize-untrusted name) for sanitizing one untrusted string. */
export const sanitizeUntrusted = (text: string): string => sanitize(text);
