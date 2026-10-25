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

// Frozen and inline: growth and shrink both turn this red. The tagged content error of the stream
// compiler, the formatter of schema issues, the tree and condition checks and the failure arm's extra
// field are all internal or part of an existing type, so none of them is here.
const PUBLIC_SURFACE = [
  'ACTION_KINDS',
  'ActionKind',
  'ActionKindSchema',
  'BoundPointer',
  'CATALOG_HEADER',
  'CapabilityProvider',
  'DynamicValue',
  'FileStat',
  'MAX_RETRIES',
  'MiniAppSpec',
  'REPAIR_HEADER',
  'RuntimeError',
  'RuntimeRepair',
  'SEMANTIC_HEADER',
  'SemanticCode',
  'SemanticIssue',
  'SemanticResult',
  'Spec',
  'SpecIssue',
  'SpecMeta',
  'UIElement',
  'ValidationEnvelope',
  'autoFixStructure',
  'buildValidationEnvelope',
  'checkCapabilities',
  'checkFiles',
  'checkVisibility',
  'collectBoundPointers',
  'compileSpecStream',
  'composeValidation',
  'createSpecStreamCompiler',
  'formatCatalogIssues',
  'formatSemanticIssues',
  'formatStructuralIssues',
  'getByPath',
  'resolveBindings',
  'toRepromptText',
  'toRuntimeRepair',
  'toWireSpec',
  'validateSemantics',
  'validateStructure',
];

describe('declaration surface golden', () => {
  it('the barrel exports exactly the frozen public surface of 41 names', () => {
    expect(PUBLIC_SURFACE).toHaveLength(41);
    expect(barrelExports()).toEqual(PUBLIC_SURFACE);
  });
});
