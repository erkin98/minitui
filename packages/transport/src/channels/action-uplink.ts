import { randomUUID } from 'node:crypto';
import {
  EventType,
  type BaseEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type ToolCallStartEvent,
} from '@ag-ui/core';

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
  params: Record<string, unknown>;
  result: { content: string; isError: boolean };
  toolCallId?: string;
  messageId?: string;
}): UplinkEvents {
  // No module-level mutable counter (immutability constraint): a per-call UUID is
  // unique without shared state. randomUUID is sync and dep-free on Node 22.
  const toolCallId = args.toolCallId ?? `uplink-${randomUUID()}`;
  const messageId = args.messageId ?? `uplink-msg-${randomUUID()}`;

  const start: ToolCallStartEvent = {
    type: EventType.TOOL_CALL_START,
    toolCallId,
    toolCallName: args.actionName,
  };
  // Params ride the ARGS delta (the AG-UI wire for tool arguments) — the minitui
  // TOOL_CALL_START has no args field, so the old `args` key was silently stripped.
  const argsEvent: ToolCallArgsEvent = {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId,
    delta: JSON.stringify(args.params),
  };
  const end: ToolCallEndEvent = {
    type: EventType.TOOL_CALL_END,
    toolCallId,
  };
  const result: ToolCallResultEvent = {
    type: EventType.TOOL_CALL_RESULT,
    // messageId is REQUIRED by AG-UI's ToolCallResultEventSchema; the old result
    // omitted it and failed the parse. Caller-supplied when the message context is
    // known, else synthesized.
    messageId,
    toolCallId,
    content: args.result.content,
    // ponytail: isError rides as a passthrough extra — AG-UI's ToolCallResultEvent
    // has no structured error field, and its schema is .passthrough() so the flag
    // survives a real parse without a cross-package schema change.
    isError: args.result.isError,
  };

  return [start, argsEvent, end, result];
}
