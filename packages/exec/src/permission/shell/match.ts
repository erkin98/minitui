// Prefix/glob matcher with a trailing word boundary. A pattern matches a value when
// the value starts with the pattern AND the next character (if any) is whitespace —
// so 'rm' never matches 'rmdir' and 'ls *' never matches 'lsof'. '*' inside a pattern
// matches a single token run (non-whitespace), never across whitespace.
const WORD = '[^\\s]*';

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join(WORD);
  // anchor at start; require either end-of-string or a whitespace boundary after the match
  return new RegExp(`^${escaped}(?=\\s|$)`);
}

export function matchPattern(pattern: string, value: string): boolean {
  return patternToRegExp(pattern.trim()).test(value.trim());
}
