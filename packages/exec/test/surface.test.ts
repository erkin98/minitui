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

// The frozen public surface of the exec package, written inline rather than auto-snapshotted:
// fifteen names, eight values and seven type-only. A name that appears and a name that vanishes both
// red, so a change to what consumers can import is a reviewed contract change, never a side effect.
// probeSandbox and hardenChildEnv are deliberately not here.
const PUBLIC_SURFACE = [
  'PathRule',
  'PermissionEngine',
  'SandboxManagerHandle',
  'SandboxPolicy',
  'SandboxProbe',
  'SandboxUnavailableError',
  'SandboxViolation',
  'SandboxViolationError',
  'WrappedArgv',
  'checkHardFloor',
  'checkPathRules',
  'createPermissionEngine',
  'createSandboxManager',
  'ensureParserReady',
  'parseShellCommand',
];

describe('declaration surface golden', () => {
  it('the barrel exports exactly the frozen public surface', () => {
    expect(barrelExports()).toEqual(PUBLIC_SURFACE);
  });
});
