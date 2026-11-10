// The shared test toolkit: real implementations of the ports, a headless host over the real Ink mount,
// golden helpers and the canonical merge fixtures. Private; never part of a product bundle.
export { KEYS, keyBytes, type KeyName } from './render/keys.js';
export { FROZEN_SIZE, SPINNER_FRAMES, stripAnsiNondeterminism } from './golden/determinism.js';
export { matchGolden, type GoldenResult } from './golden/golden.js';
export { mountHarness, type InkHarness } from './render/ink-harness.js';
export { MockLlmProvider, type MockChunk, type MockProviderOptions } from './llm/mock-provider.js';
export { ScriptedRun, scriptedRun } from './llm/scripted-run.js';
export {
  MockPermissionEngine,
  UNRECOGNISED_REPLY,
  createMockPermissionEngine,
  type MockApprovalMode,
  type MockPermissionReply,
  type PermissionRecord,
  type Policy,
} from './tools/mock-permission-engine.js';
export {
  createTestConsentController,
  type ConsentSource,
} from './tools/test-consent-controller.js';
export {
  MockToolRegistry,
  createMockToolRegistry,
  type ScriptedTool,
  type ToolLifecycleEvent,
  type ToolOutcome,
} from './tools/mock-tool-registry.js';
export {
  MERGE_RUN,
  MERGE_SPEC,
  MERGE_TOOL_FAIL,
  MERGE_TOOL_OK,
  SPEC_FILES,
  specPatchText,
} from './fixtures/merge-task.fixtures.js';
export { createMockDispatcher, mountHeadless, type HeadlessHost } from './render/headless-host.js';
