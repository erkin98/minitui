import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Enumerate every name the barrel exports (value and type-only).
function barrelExports(): string[] {
  const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
  const program = ts.createProgram([entry], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.ReactJSX,
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

// Frozen and inline: growth and shrink both turn this red. This is the swap boundary's published
// surface: the port factory, the mount, the handler builders, the consent seam and the widgets.
// 16 values and 7 types. The internal refusal class, the port mount function and the state-patch
// module are not here.
const PUBLIC_SURFACE = [
  'BuildHandlersArgs',
  'Button',
  'CommandPreview',
  'ConsentController',
  'ConsentDecision',
  'ConsentOverlay',
  'ELEMENT_KEY',
  'FilePicker',
  'GatedHandlerArgs',
  'InkRendererDeps',
  'MountInkArgs',
  'OrderList',
  'ProgressWidget',
  'RENDER_LOCAL_ALLOWLIST',
  'WidgetProps',
  'assertSpecOnCatalog',
  'buildHandlers',
  'createInkBinding',
  'createInkRenderer',
  'gatedHandler',
  'isRenderLocalAllowed',
  'makeOffCatalogFallback',
  'mountInk',
];

describe('declaration surface golden', () => {
  it('the barrel exports exactly the frozen public surface of 23 names', () => {
    expect(PUBLIC_SURFACE).toHaveLength(23);
    expect(barrelExports()).toEqual(PUBLIC_SURFACE);
  });
});
