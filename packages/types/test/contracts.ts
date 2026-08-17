// Compile-time shape contracts for the public surface. surface.test.ts locks the
// export NAMES; this file locks the SHAPES of load-bearing exported types so a
// silent field/discriminant drift reds `tsc -p tsconfig.test.json`.
// Type-only: vitest ignores it (no `.test` suffix); tsc typechecks it under the
// package's strict flags (tsconfig.test includes test/**/*.ts). No runtime code.
import type { Pointer } from '../src/pointer.js';
import type { AgentEvent, EventType } from '../src/events.js';
import type { Decision } from '../src/permission.js';
import type {
  ExecEvent,
  McpBridgePort,
  McpCallOptions,
  McpCallResult,
  McpProgress,
  McpToolRecord,
  PermissionGatePort,
} from '../src/ports.js';

// Invariant type-equality (distinguishes optional/readonly/union differences).
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// Pointer is a BRANDED string: a bare string is NOT assignable to it. The
// name-only surface golden cannot see the brand — drop it and this reds.
export type _PointerIsBranded = Expect<Equal<[string] extends [Pointer] ? true : false, false>>;

// The streamed-exec discriminant tags are exactly these four.
export type _ExecEventKinds = Expect<
  Equal<ExecEvent['kind'], 'stdout' | 'stderr' | 'progress' | 'exit'>
>;

type ExpectedExecEvent =
  | { readonly kind: 'stdout'; readonly chunk: string }
  | { readonly kind: 'stderr'; readonly chunk: string }
  | { readonly kind: 'progress'; readonly value: number; readonly message?: string | undefined }
  | { readonly kind: 'exit'; readonly code: number };

export type _ExecEventExact = Expect<Equal<ExecEvent, ExpectedExecEvent>>;

// The deny-first decision discriminants are exactly these three.
export type _DecisionKinds = Expect<Equal<Decision['kind'], 'allow' | 'deny' | 'ask'>>;

// The AgentEvent union's discriminants EXACTLY mirror the EventType vocabulary —
// the two hand-maintained lists (EVENT_TYPES enum vs AgentEventSchema) cannot drift
// apart silently (also closes the missing EVENT_TYPES<->AgentEvent consistency gate).
export type _AgentEventMirrorsVocabulary = Expect<Equal<AgentEvent['type'], EventType>>;

type ExpectedMcpToolRecord = {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema: import('../src/pointer.js').JsonValue;
};
type ExpectedMcpProgress = {
  readonly progress: number;
  readonly total?: number | undefined;
  readonly message?: string | undefined;
};
type ExpectedMcpCallOptions = {
  readonly signal: AbortSignal;
  readonly onProgress?: ((progress: McpProgress) => void) | undefined;
  readonly timeoutMs?: number | undefined;
};
type ExpectedMcpCallResult = {
  readonly isError: boolean;
  readonly content: readonly import('../src/pointer.js').JsonValue[];
  readonly text: string;
};

export type _McpToolRecordExact = Expect<Equal<McpToolRecord, ExpectedMcpToolRecord>>;
export type _McpProgressExact = Expect<Equal<McpProgress, ExpectedMcpProgress>>;
export type _McpCallOptionsExact = Expect<Equal<McpCallOptions, ExpectedMcpCallOptions>>;
export type _McpCallResultExact = Expect<Equal<McpCallResult, ExpectedMcpCallResult>>;
export type _McpListToolsExact = Expect<
  Equal<McpBridgePort['listTools'], () => Promise<readonly McpToolRecord[]>>
>;
export type _McpCallToolExact = Expect<
  Equal<
    McpBridgePort['callTool'],
    (
      namespacedName: string,
      params: Readonly<Record<string, import('../src/pointer.js').JsonValue>>,
      opts: McpCallOptions,
    ) => Promise<McpCallResult>
  >
>;
export type _McpTeardownExact = Expect<Equal<McpBridgePort['teardown'], () => Promise<void>>>;
export type _PermissionCheckExact = Expect<
  Equal<
    PermissionGatePort['check'],
    (request: import('../src/permission.js').PermissionRequest) => Promise<Decision>
  >
>;
export type _PermissionRequestsExact = Expect<
  Equal<
    PermissionGatePort['requests'],
    AsyncIterable<import('../src/permission.js').PermissionRequest>
  >
>;
