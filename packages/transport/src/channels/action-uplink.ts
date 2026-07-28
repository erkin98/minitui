import { randomUUID } from 'node:crypto';
import {
  EventType,
  type BaseEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type ToolCallStartEvent,
} from '@ag-ui/core';
import { JsonObjectSchema } from '@minitui/types';

/**
 * The AG-UI tool-call lifecycle for one uplinked UI action, in emission order:
 * TOOL_CALL_START -> TOOL_CALL_ARGS -> TOOL_CALL_END -> TOOL_CALL_RESULT. Each is a
 * concrete, schema-valid AG-UI event (no `as` casts) so a consumer's verifyEvents /
 * apply pipeline accepts the stream and the params are never silently dropped.
 */
export type UplinkEvents = readonly BaseEvent[];

/** A UI action becomes a synthetic tool-call lifecycle keyed to one toolCallId. */
export function buildActionUplink(args: {
  actionName: string;
  params: unknown;
  result: {
    content: string;
    isError: boolean;
    error?: string | undefined;
    denied?: boolean | undefined;
  };
  toolCallId?: string;
  messageId?: string;
}): UplinkEvents {
  const params = JsonObjectSchema.parse(args.params);
  const paramsJson = JSON.stringify(params);
  if (typeof paramsJson !== 'string') throw new TypeError('action params are not JSON');
  // No module-level mutable counter (immutability constraint): a per-call UUID is
  // unique without shared state. randomUUID is sync and dep-free on Node 22.
  const toolCallId = args.toolCallId ?? `uplink-${randomUUID()}`;
  const messageId = args.messageId ?? `uplink-msg-${randomUUID()}`;

  const start: ToolCallStartEvent = {
    type: EventType.TOOL_CALL_START,
    toolCallId,
    toolCallName: args.actionName,
  };
  // Params ride the ARGS delta because TOOL_CALL_START has no arguments field.
  const argsEvent: ToolCallArgsEvent = {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId,
    delta: paramsJson,
  };
  const end: ToolCallEndEvent = {
    type: EventType.TOOL_CALL_END,
    toolCallId,
  };
  const result: ToolCallResultEvent = {
    type: EventType.TOOL_CALL_RESULT,
    // AG-UI requires messageId; callers may supply the surrounding message identity.
    messageId,
    toolCallId,
    content: args.result.content,
    // AG-UI has no structured error field, so minitui error metadata uses the
    // schema's passthrough extension surface.
    isError: args.result.isError,
    toolName: args.actionName,
    ...(args.result.error === undefined ? {} : { error: args.result.error }),
    ...(args.result.denied === undefined ? {} : { denied: args.result.denied }),
  };

  return [start, argsEvent, end, result];
}
