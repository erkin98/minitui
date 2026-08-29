import type { JsonValue } from '@minitui/types';

export interface ToolCallRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, JsonValue>>;
}

// Local vocabulary; unit 11's provider seam maps it onto the AI SDK's tool-result
// part: content -> output{type:'text'}, error/isError -> {type:'error-text'},
// denied -> {type:'execution-denied'}.
export interface ToolCallResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly ok: boolean;
  readonly content: unknown;
  readonly isError: boolean;
  readonly error?: string | undefined; // failure text, separate from content
  readonly denied?: boolean | undefined; // permission refusal, distinct from a tool failure
}

// The SOLE seam from the model loop to execution. The host wires permission +
// exec into this; agent-core imports neither @minitui/exec nor child_process.
export interface ToolDispatchPort {
  dispatch(req: ToolCallRequest, signal: AbortSignal): Promise<ToolCallResult>;
}
