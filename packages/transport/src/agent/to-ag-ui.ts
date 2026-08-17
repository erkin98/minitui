import { EventType, type BaseEvent } from '@ag-ui/core';

/**
 * Explicit minitui -> AG-UI adapter. minitui's wire vocabulary mirrors AG-UI's own
 * field names where a field exists at all — RUN_STARTED/RUN_FINISHED carry threadId+runId,
 * TOOL_CALL_START carries toolCallName (never toolName) — so nothing needs renaming there. The
 * one field genuinely absent everywhere is messageId (agent-core has no message-identity
 * concept), and ACTIVITY_SNAPSHOT's minitui-owned { spec } payload does not match AG-UI's
 * required { messageId, activityType, content } shape at all, so that event gets reshaped
 * rather than merely stamped.
 *
 * Reserved for a genuinely-remote BFF (Slice 2+) that runs the same agent-core loop behind an
 * HTTP+SSE endpoint and must speak real AG-UI wire protocol; the Slice-1 in-process path
 * (local-agent.ts) never crosses this boundary — it feeds MinituiEvent straight through
 * toAppEvent.
 */
export interface AgUiSynthesisContext {
  readonly threadId: string;
  readonly runId: string;
  readonly messageId: string;
}

const ACTIVITY_TYPE = 'mini-app-spec';

export function toAgUiEvent(
  raw: { type: string } & Record<string, unknown>,
  ctx: AgUiSynthesisContext,
): BaseEvent {
  // boundary-only enum claim, same pattern as the toAppEvent switch predicate
  if ((raw.type as EventType) === EventType.ACTIVITY_SNAPSHOT) {
    const { spec, ...rest } = raw;
    // activityType and content are this adapter's own projection of the minitui payload,
    // so they are assigned last and always win. messageId is synthesis, not translation:
    // the minitui event has no message identity of its own, so ctx supplies it.
    return {
      ...rest,
      messageId: ctx.messageId,
      activityType: ACTIVITY_TYPE,
      content: spec,
    } as unknown as BaseEvent;
  }
  // ctx FILLS GAPS, it does not overwrite. A minitui run event carries its own required
  // threadId/runId; replacing them with the context's would rewrite real identity. Only
  // fields the event genuinely lacks (messageId, and the ids on events that omit them)
  // fall back to ctx.
  return {
    threadId: ctx.threadId,
    runId: ctx.runId,
    messageId: ctx.messageId,
    ...raw,
  } as unknown as BaseEvent;
}
