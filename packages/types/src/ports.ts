import type { Decision, PermissionRequest } from './permission.js';
import type { JsonValue } from './pointer.js';

// A unit of streamed execution output (local runner or MCP tool call).
export type ExecEvent =
  | { readonly kind: 'stdout'; readonly chunk: string }
  | { readonly kind: 'stderr'; readonly chunk: string }
  | { readonly kind: 'progress'; readonly value: number; readonly message?: string | undefined }
  | { readonly kind: 'exit'; readonly code: number };

// MCP wire shapes — defined HERE (not exec) so the McpBridgePort contract stays
// in zero-internal-dep types; the MCP client pool imports these, never redefines them.
export interface McpToolRecord {
  readonly name: string; // namespaced mcp__server__tool
  readonly description?: string | undefined;
  readonly inputSchema: JsonValue; // JSON Schema for the tool args
}

// One MCP progress notification, forwarded through the port (the SDK's
// RequestOptions.onprogress payload). The MCP client pool maps SDK progress to this.
export interface McpProgress {
  readonly progress: number;
  readonly total?: number | undefined;
  readonly message?: string | undefined;
}

// Mirrors the slice of the real MCP SDK v2 RequestOptions the pool forwards:
// onprogress/signal/timeout (the MCP SDK v2 RequestOptions in shared/protocol.ts).
// Signal-only would strand the pool's progress handler and the per-call timeout.
export interface McpCallOptions {
  readonly signal: AbortSignal;
  readonly onProgress?: ((p: McpProgress) => void) | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface McpCallResult {
  readonly isError: boolean;
  readonly content: readonly JsonValue[];
  readonly text: string;
}

// The host runs the gate; the renderer never imports this. exec implements it.
export interface PermissionGatePort {
  check(req: PermissionRequest): Promise<Decision>;
  readonly requests: AsyncIterable<PermissionRequest>;
}

// Lazy, gated MCP tool calls — the three-method shape the lazy MCP client pool
// implements (createMcpClientPool(): McpBridgePort). callTool resolves to a single
// McpCallResult (not a stream; progress arrives via opts.onProgress); listTools
// enumerates the gated surface AS ONE LIST — the impl aggregates the SDK's
// paginated tools/list under the hood. teardown closes the pooled
// clients.
export interface McpBridgePort {
  listTools(): Promise<readonly McpToolRecord[]>;
  callTool(
    namespacedName: string,
    params: Readonly<Record<string, JsonValue>>,
    opts: McpCallOptions,
  ): Promise<McpCallResult>;
  teardown(): Promise<void>;
}
