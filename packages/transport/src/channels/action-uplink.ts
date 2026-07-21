import { randomUUID } from 'node:crypto';
import { EventType, type BaseEvent } from '@ag-ui/core';

export interface UplinkEvents {
  toolCall: BaseEvent;
  result: BaseEvent;
}

/** A UI action becomes a synthetic tool-call + TOOL_CALL_RESULT keyed to one toolCallId. */
export function buildActionUplink(args: {
  actionName: string;
  params: Record<string, unknown>;
  result: { content: string; isError: boolean };
  toolCallId?: string;
}): UplinkEvents {
  // No module-level mutable counter (immutability constraint): a per-call UUID is unique
  // without shared state. randomUUID is sync and dep-free on Node 22.
  const toolCallId = args.toolCallId ?? `uplink-${randomUUID()}`;
  const toolCall = {
    type: EventType.TOOL_CALL_START,
    toolCallId,
    toolCallName: args.actionName,
    args: JSON.stringify(args.params),
  } as unknown as BaseEvent;
  const result = {
    type: EventType.TOOL_CALL_RESULT,
    toolCallId,
    toolName: args.actionName,
    content: args.result.content,
    isError: args.result.isError,
  } as unknown as BaseEvent;
  return { toolCall, result };
}
