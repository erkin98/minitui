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

// Frozen, inline public surface rather than an auto-written snapshot. Materialized from:
// `console.log(JSON.stringify(barrelExports()))`, then pasted here sorted.
// Includes the seven port names the runtime barrel test cannot see
// (ExecEvent, McpBridgePort, McpCallOptions, McpCallResult, McpProgress,
// McpToolRecord, PermissionGatePort).
const PUBLIC_SURFACE = [
  'ACTION_KINDS',
  'ActionBinding',
  'ActionBindingSchema',
  'ActionKind',
  'ActionKindSchema',
  'CatalogVisibilitySource',
  'VisibilityClass',
  'ActionRequest',
  'ActionRequestSchema',
  'ActionResult',
  'ActionResultSchema',
  'AgentEvent',
  'AgentEventSchema',
  'AppSpec',
  'AppSpecSchema',
  'ApprovalMode',
  'ApprovalModeSchema',
  'CURRENT_SCHEMA_VERSION',
  'CommandRoot',
  'CommandRootSchema',
  'Decision',
  'DecisionSchema',
  'DiagnosticsPort',
  'EVENT_TYPES',
  'EventType',
  'EventTypeSchema',
  'ExecEvent',
  'ExecSurface',
  'ExecSurfaceSchema',
  'JsonObjectSchema',
  'JSON_RESOURCE_LIMITS',
  'JsonPatch',
  'JsonPatchArraySchema',
  'JsonPatchSchema',
  'JsonValue',
  'JsonValueSchema',
  'KeptApp',
  'KeptAppSchema',
  'Manifest',
  'ManifestSchema',
  'McpBridgePort',
  'McpCallOptions',
  'McpCallResult',
  'McpProgress',
  'McpToolRecord',
  'ParamDescriptor',
  'ParamDescriptorSchema',
  'ParsedCommand',
  'ParsedCommandSchema',
  'PermissionDescriptor',
  'PermissionDescriptorSchema',
  'PermissionGatePort',
  'PermissionReply',
  'PermissionReplySchema',
  'PermissionRequest',
  'PermissionRequestSchema',
  'PermissionRule',
  'PermissionRuleSchema',
  'Pointer',
  'PointerSchema',
  'Rule',
  'RuntimeFault',
  'RuntimeFaultSchema',
  'SchemaVersion',
  'SchemaVersionSchema',
  'SpecElement',
  'SpecElementSchema',
  'TokenUsage',
  'TokenUsageSchema',
  'assertJsonResourceBudget',
  'assertNever',
  'guardReservedKeys',
  'guardedRecord',
  'noopDiagnostics',
].sort();

describe('@minitui/types public declaration surface', () => {
  it('exports EXACTLY the frozen public set (shrink AND growth red)', () => {
    expect(barrelExports()).toEqual(PUBLIC_SURFACE);
  });
});
