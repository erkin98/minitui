import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Enumerate every name the barrel exports (value + type-only).
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

// The frozen public surface, written out rather than snapshotted: growth and shrink both fail,
// so a name that silently leaves or enters what other packages import is a visible change.
const VALUES = [
  'CATALOG_REPAIR_WORDING',
  'DEFAULT_VISIBILITY',
  'MAX_ELEMENT_DEPTH',
  'SECRET_VISIBILITY',
  'STD_ACTION_NAMES',
  'applyResourceTemplate',
  'buildCatalogPrompt',
  'checkActionParams',
  'checkElementTree',
  'checkSemantics',
  'defineAction',
  'defineComponent',
  'defineMinituiCatalog',
  'hasCanonicalKeys',
  'hostCatalogDeps',
  'isWiderThan',
  'rejectOffCatalog',
  'requiresPermission',
  'resolvePointer',
  'runFullValidation',
  'sanitize',
  'sanitizeSpecStrings',
  'standardActionDefinitions',
  'standardComponentDefinitions',
  'throwingFallback',
  'videoMergeCatalog',
];
const TYPES = [
  'ActionBinding',
  'ActionDefinition',
  'ActionKind',
  'AllowlistIssue',
  'AppSpec',
  'ComponentDefinition',
  'ElementTreeIssue',
  'MinituiActionDef',
  'MinituiCatalog',
  'MinituiComponentDef',
  'ParamsCatalog',
  'PermissionDescriptor',
  'SemanticIssue',
  'SpecElement',
  'TrustTier',
  'ValidationIssue',
  'ValidationResult',
  'VisibilityClass',
];
const PUBLIC_SURFACE = [...VALUES, ...TYPES].sort();

describe('catalog public surface', () => {
  it('exports exactly the frozen names', () => {
    expect(barrelExports()).toEqual(PUBLIC_SURFACE);
  });

  it('lists 44 names: 26 values and 18 types', () => {
    expect(VALUES).toHaveLength(26);
    expect(TYPES).toHaveLength(18);
    expect(PUBLIC_SURFACE).toHaveLength(44);
  });
});
