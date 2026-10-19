import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import config from '../tsup.config.js';

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

// The frozen public surface, written out rather than snapshotted: growth and shrink both fail, so a name
// that silently leaves or enters what other packages import is a visible change.
const PUBLIC_SURFACE = [
  'AgentConfig',
  'AgentSession',
  'CatalogVisibilityClass',
  'CatalogVisibilitySource',
  'Clock',
  'ContextOverflowError',
  'DEFAULT_STEP_CEILING',
  'FinishReason',
  'MinituiEvent',
  'ModelConfig',
  'ModelProvider',
  'ObservationInput',
  'ProviderChunk',
  'ProviderError',
  'ProviderMessage',
  'ProviderRegistry',
  'ProviderRequest',
  'RedactionPolicy',
  'RepairIngress',
  'RouteError',
  'RuntimeRepairBuilder',
  'SpecSinkPort',
  'ToolCallRequest',
  'ToolCallResult',
  'ToolDispatchPort',
  'ToolSchema',
  'VisibilityChannel',
  'VisibilityClass',
  'VisibilityMap',
  'catalogVisibilityToChannel',
  'createAiSdkProvider',
  'createAnthropicModel',
  'createMockProvider',
  'createProviderRegistry',
  'createSpecSink',
  'createVisibilityChannel',
  'fixedClock',
  'isTerminal',
  'redact',
  'redactDeep',
  'repeatedToolCallDetector',
  'routeObservation',
  'routeRuntimeFault',
  'routeToolCallResult',
  'steppingClock',
  'summarizeExecEvents',
  'systemClock',
  'toRunError',
];

describe('agent-core public surface', () => {
  it('exports exactly the frozen names', () => {
    expect(barrelExports()).toEqual(PUBLIC_SURFACE);
  });

  it('lists 48 names', () => {
    expect(PUBLIC_SURFACE).toHaveLength(48);
  });
});

describe('what the published declarations need', () => {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

  it('ships the node types as a dependency, not a development one', () => {
    expect(Object.keys(manifest.dependencies ?? {})).toContain('@types/node');
    expect(Object.keys(manifest.devDependencies ?? {})).not.toContain('@types/node');
  });

  it('puts the node reference line at the top of the declaration build', () => {
    // a reference in a source file is dropped by the declaration rollup, so it is injected at emit
    if (typeof config === 'function' || Array.isArray(config))
      throw new Error('unexpected config shape');
    const dts = config.dts;
    expect(typeof dts === 'object' ? dts.banner : undefined).toBe('/// <reference types="node" />');
  });
});
