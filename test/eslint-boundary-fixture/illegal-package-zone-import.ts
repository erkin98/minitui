// Planted witness for the from:'./packages' + `except` zone encoding that every real
// package zone in config/eslint-boundaries.js uses. The sibling illegal-import.ts and
// illegal-by-name-import.ts zones are bare file-target zones with no `except`, so before
// this file the except mechanics — the half of import/no-restricted-paths that re-permits
// a package's own dir and its allowed deps — had no witness at all: a plugin or resolver
// drift that over-permitted `except` would silently disarm all twelve package zones while
// both existing fixtures stayed red.
//
// The boundaries config re-targets the LIVE spec zone (allowed set: types + catalog) at
// this file. @minitui/sanitizer sits outside that allowed set, so this import must report
// exactly ['import/no-restricted-paths']; if `except` ever over-permits, the error
// disappears and the fixture registry reds on the missing expectation. Never built or
// shipped — the repo-wide lint ignores this directory; the policy-fixtures gate targets it.
import { sanitize } from '@minitui/sanitizer';

export const witness = sanitize;
