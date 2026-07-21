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
// §Z32 vacuous-golden trap; §Z102 declaration-surface gate). This is the seam
// every downstream layer reads state and events through: the agent-port swap
// seam, the normalization chokepoint, the canonical store, the bounded bus,
// the channels, and the two contract-only seam ports. Surface SHRINK and
// GROWTH both red — a chokepoint entry silently vanishing from (or leaking
// into) the public seam is a contract change, not a refactor.
const PUBLIC_SURFACE = [
  'ActionDispatcherPort',
  'AgUiSynthesisContext',
  'AgentPort',
  'AppBus',
  'AppError',
  'AppEvent',
  'AppEventKind',
  'BoundedQueue',
  'BusPort',
  'COALESCIBLE',
  'CONSUMED_KINDS',
  'DataStore',
  'JsonPatchOp',
  'JsonValue',
  'PatchError',
  'Pointer',
  'RendererFeedPort',
  'RunHandle',
  'SeqGuard',
  'SeqVerdict',
  'StorePort',
  'Topic',
  'TopicPayloads',
  'UplinkEvents',
  'WireEvent',
  'applyStatePatch',
  'buildActionUplink',
  'buildRunAgentInput',
  'createAbort',
  'createAgUiAgentPort',
  'createAppBus',
  'createDataStore',
  'createLocalAgentPort',
  'createSeqGuard',
  'foldDelta',
  'foldSnapshot',
  'getIn',
  'parsePointer',
  'removeIn',
  'sanitizeStrings',
  'setIn',
  'subscribeToObservable',
  'toAgUiEvent',
  'toAppError',
  'toAppEvent',
  'toVisibilityNote',
];

describe('declaration surface golden', () => {
  it('the barrel exports exactly the frozen public surface', () => {
    expect(barrelExports()).toEqual(PUBLIC_SURFACE);
  });
});
