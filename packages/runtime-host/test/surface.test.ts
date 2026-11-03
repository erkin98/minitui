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

// Frozen, inline public surface rather than an auto-written snapshot. The host's own action router,
// state view and render-local action list stay inside the package: the composition root builds one
// host through createAppHost and never touches them, and the router's natural name belongs to exec.
// Growth and shrinkage both red.
const PUBLIC_SURFACE = [
  'AppHost',
  'AppHostDeps',
  'BindError',
  'BindInput',
  'BindResult',
  'HostSession',
  'HostState',
  'TaskOutcome',
  'bindRelaunchParams',
  'createAppHost',
];

describe('declaration surface golden', () => {
  it('the barrel exports exactly the frozen public surface', () => {
    expect(barrelExports()).toEqual(PUBLIC_SURFACE);
  });
});
