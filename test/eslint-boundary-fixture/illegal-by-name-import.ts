// Cold by-name witness for the package-DAG gate (import/no-restricted-paths).
//
// The sibling illegal-import.ts fixture uses a RELATIVE specifier, so it proves only that
// the rule fires on a shape production code does not use. Every real cross-package edge is
// written by NAME (`@minitui/types`, `@minitui/sanitizer`), and a by-name specifier is
// resolved through the package `exports` map to dist/ unless the resolver is pointed at
// source. On a cold clone there is no dist/, resolution yields nothing, the rule receives no
// path, and a forbidden by-name edge is silently unflagged.
//
// This file is treated as a leaf: it may import no internal package at all. It sits outside
// every package tsconfig, so it joins no build and ships nowhere. Its registered expectation
// is exactly ['import/no-restricted-paths'] — if the resolver ever stops reaching source,
// this fixture reports NO error and the registry reds on the missing expected rule id.
import { sanitize } from '@minitui/sanitizer';

export const witness = sanitize;
