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

// Frozen, inline public surface rather than an auto-written snapshot. The boundary is type-only, so
// growth and shrink both red: a name that silently leaves the barrel breaks every renderer, and a
// name that leaks in widens the seam between the host and the renderer.
const PUBLIC_SURFACE = [
  'ActionDispatcher',
  'ActionKind',
  'ActionLifecycleEvent',
  'ActionOutcome',
  'DispatchContext',
  'LifecycleEmitter',
  'RenderHandle',
  'RendererPort',
  'RendererRefusalCode',
  'WidgetCatalogBinding',
];

describe('declaration surface golden', () => {
  it('the barrel exports exactly the frozen public surface', () => {
    expect(barrelExports()).toEqual(PUBLIC_SURFACE);
  });
});
