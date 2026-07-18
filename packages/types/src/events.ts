import { z } from 'zod';
import { JsonPatchArraySchema, JsonValueSchema } from './pointer.js';
import { AppSpecSchema } from './spec.js';

// The AG-UI EventType families minitui consumes (design §7). This is a VOCABULARY
// MIRROR, NOT a re-export: types is zero-dep so it cannot import @ag-ui/core. These
// payloads are minitui-OWNED and NOT wire-compatible with @ag-ui/core (ledger G12) —
// transport owns the EXPLICIT minitui<->AG-UI adapter + the @ag-ui/client
// transformChunks/verifyEvents/apply pipeline. Where a field IS mirrored its name
// matches @ag-ui/core verbatim (threadId/runId, message/code, toolCallId/
// toolCallName, snapshot, delta, name/value) so the adapter stays mechanical;
// minitui does not re-verify the AG-UI stream.
export const EVENT_TYPES = [
  'RUN_STARTED',
  'RUN_FINISHED',
  'RUN_ERROR',
  'STATE_SNAPSHOT',
  'STATE_DELTA',
  'TEXT_MESSAGE_CONTENT',
  'TOOL_CALL_START',
  'TOOL_CALL_RESULT',
  'ACTIVITY_SNAPSHOT',
  'CUSTOM',
] as const;
export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

// Per-event token usage (ledger §Z103): the enforcement point for provider-
// supplied counts. Extracted from the inline RUN_FINISHED shape so plan-11
// (producer) and plan-04 (remote @ag-ui/client wire) can PARSE-not-cast at their
// boundaries — the guard is inert until something parses it. NO `.readonly()`:
// z.infer stays the §Z53-C mutable shape the plan-15 accumulator sums.
export const TokenUsageSchema = z.object({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

// The minitui-relevant payload shapes, discriminated by `type`.
// threadId/runId are REQUIRED on run lifecycle, matching AG-UI's RunStarted/
// RunFinished schemas — agent-core owns run identity, so the adapter never
// synthesizes ids. RUN_ERROR mirrors AG-UI's { message, code? } (a retry hint
// has no wire source field; if ever needed it rides CUSTOM).
export const AgentEventSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('RUN_STARTED'), threadId: z.string(), runId: z.string() }),
    // minitui-owned divergence (ledger §Z57-A): usage is OPTIONAL and NOT mirrored
    // from AG-UI — RunFinishedEventSchema carries result?/outcome? instead, no
    // usage field (verified against repos/ag-ui/.../core/src/events.ts:238-247).
    // The §Z9 status frame (plan 15) accumulates cumulative session tokens from
    // this field; the provider factory (plan 11) populates it from the AI SDK's
    // finish-step totalUsage, and the adapter simply omits it crossing outbound
    // (nothing on the AG-UI wire to map it to).
    z.object({
      type: z.literal('RUN_FINISHED'),
      threadId: z.string(),
      runId: z.string(),
      usage: TokenUsageSchema.optional(),
    }),
    z.object({ type: z.literal('RUN_ERROR'), message: z.string(), code: z.string().optional() }),
    z.object({ type: z.literal('STATE_SNAPSHOT'), snapshot: JsonValueSchema }),
    z.object({ type: z.literal('STATE_DELTA'), delta: JsonPatchArraySchema }),
    z.object({ type: z.literal('TEXT_MESSAGE_CONTENT'), delta: z.string() }),
    // AG-UI names the tool field toolCallName (ToolCallStartEventSchema) — NOT toolName.
    z.object({
      type: z.literal('TOOL_CALL_START'),
      toolCallId: z.string(),
      toolCallName: z.string(),
    }),
    // minitui-owned divergence: toolName + isError are REQUIRED (ledger §Z41 —
    // matching the §B16 agentObservation factory, which always supplies both);
    // error?/denied? stay optional. AG-UI's ToolCallResultEvent instead requires
    // messageId (adapter synthesizes it outbound) and has none of these fields.
    z.object({
      type: z.literal('TOOL_CALL_RESULT'),
      toolCallId: z.string(),
      toolName: z.string(),
      content: z.string(),
      isError: z.boolean(),
      error: z.string().optional(),
      denied: z.boolean().optional(),
    }),
    // minitui-owned payload pinned { spec } (ledger G9). AG-UI's ACTIVITY_SNAPSHOT is
    // { messageId, activityType, content } — the adapter nests the spec into content.
    z.object({ type: z.literal('ACTIVITY_SNAPSHOT'), spec: AppSpecSchema }),
    z.object({ type: z.literal('CUSTOM'), name: z.string(), value: JsonValueSchema }),
  ])
  .readonly();
export type AgentEvent = z.infer<typeof AgentEventSchema>;
