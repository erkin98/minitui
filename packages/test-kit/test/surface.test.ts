import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Enumerate every name the barrel exports (value and type-only).
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

// Frozen, inline public surface rather than an auto-written snapshot: every name a commit adds to the
// barrel is added here in the same commit. Growth and shrinkage both red.
const PUBLIC_SURFACE = [
  'FROZEN_SIZE',
  'GoldenResult',
  'InkHarness',
  'KEYS',
  'KeyName',
  'SPINNER_FRAMES',
  'keyBytes',
  'matchGolden',
  'mountHarness',
  'stripAnsiNondeterminism',
];

describe('declaration surface golden', () => {
  it('the barrel exports exactly the frozen public surface', () => {
    expect(barrelExports()).toEqual(PUBLIC_SURFACE);
  });
});
