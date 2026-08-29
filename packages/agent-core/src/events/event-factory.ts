import { TokenUsageSchema, type AppSpec, type JsonValue } from '@minitui/types';
import type { MinituiEvent } from './event-types.js';

/** runId is REQUIRED on the run lifecycle — agent-core owns run identity (one runId per submit()). */
export function runStarted(threadId: string, runId: string): MinituiEvent {
  return { type: 'RUN_STARTED', threadId, runId };
}

/**
 * usage threads the provider's token/cost totals when its finish chunk supplied them.
 * Parse `usage` through the canonical `TokenUsageSchema` at construction — a negative /
 * fractional / unsafe (> 2^53) provider count FAILS SOFT: the field DROPS and RUN_FINISHED still
 * fires. Never throw (a cosmetic counter must not abort a completed run), never clamp-to-0 (dropping
 * is honest, clamping lies). Covers the SDK finish path AND the non-SDK chunk path (both funnel here).
 */
export function runFinished(
  threadId: string,
  runId: string,
  usage?: { inputTokens: number; outputTokens: number },
): MinituiEvent {
  const parsed = usage !== undefined ? TokenUsageSchema.safeParse(usage) : undefined;
  return {
    type: 'RUN_FINISHED',
    threadId,
    runId,
    ...(parsed?.success ? { usage: parsed.data } : {}),
  };
}

/** RUN_ERROR is { message, code? } on the wire (no retriable field); non-retriable maps to a code. */
export function runError(message: string, code?: string): MinituiEvent {
  return { type: 'RUN_ERROR', message, code };
}

export function textContent(delta: string): MinituiEvent {
  return { type: 'TEXT_MESSAGE_CONTENT', delta };
}

/** AG-UI's ToolCallStart names the tool field toolCallName — NOT toolName. */
export function toolCallStart(toolCallId: string, toolCallName: string): MinituiEvent {
  return { type: 'TOOL_CALL_START', toolCallId, toolCallName };
}

/**
 * The model-visible exec observation (the error/result channel). Yields a TOOL_CALL_RESULT-typed
 * event — the observation-router imports THIS constructor rather than inventing one in a file it does
 * not own. Carries the optional `denied` bit so a permission-gate refusal survives structurally,
 * distinct from an execution failure — never flattened into text.
 */
export function agentObservation(args: {
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
  error?: string;
  denied?: boolean;
}): MinituiEvent {
  return {
    type: 'TOOL_CALL_RESULT',
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    content: args.content,
    isError: args.isError,
    ...(args.error !== undefined ? { error: args.error } : {}),
    ...(args.denied !== undefined ? { denied: args.denied } : {}),
  };
}

export function activitySnapshot(spec: AppSpec): MinituiEvent {
  return { type: 'ACTIVITY_SNAPSHOT', spec };
}

/** The CUSTOM escape hatch — carries payloads with no dedicated tag (e.g. tool-approval events). */
export function custom(name: string, value: JsonValue): MinituiEvent {
  return { type: 'CUSTOM', name, value };
}
