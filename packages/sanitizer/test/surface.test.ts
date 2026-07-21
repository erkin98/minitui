import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Enumerate every name the barrel re-exports (value + type-only).
function barrelExports(): string[] {
  const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
  const program = ts.createProgram([entry], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const src = program.getSourceFile(entry);
  const mod = src && checker.getSymbolAtLocation(src);
  if (!mod) throw new Error('barrel is not a module');
  return checker
    .getExportsOfModule(mod)
    .map((s) => s.name)
    .sort();
}

// FROZEN, INLINE-committed public surface (NOT an auto-written snapshot —
// §Z32 vacuous-golden trap; §Z102 declaration-surface gate). The chokepoint's
// surface is deliberately tiny: the §4 trio, the options bag, the OSC 8
// allowlist constant, and the §X4 width helper. Surface SHRINK and GROWTH
// both red — a strip entry point silently vanishing from (or leaking into)
// the public seam is a security-surface change, not a refactor.
const PUBLIC_SURFACE = [
  'ALLOWED_OSC8_SCHEMES',
  'SanitizeOptions',
  'sanitize',
  'sanitizeSpecStrings',
  'sanitizeStream',
  'stripHyperlinks',
];

describe('declaration surface golden', () => {
  it('the barrel exports exactly the frozen public surface', () => {
    expect(barrelExports()).toEqual(PUBLIC_SURFACE);
  });
});
