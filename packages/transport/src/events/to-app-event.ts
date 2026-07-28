import { EventType, type BaseEvent } from '@ag-ui/core';
import {
  AppSpecSchema,
  JsonPatchArraySchema,
  JsonValueSchema,
  TokenUsageSchema,
} from '@minitui/types';
import { formatUnknown } from '../format-unknown.js';
import type { AppEvent } from './app-event.js';

const NON_RETRIABLE_CODES = new Set([
  'non-retriable',
  'ContextOverflow',
  'context_overflow',
  'context_length_exceeded',
]);
const VIS_CLASSES = new Set(['modelVisible', 'modelOnly', 'localOnly']);

export type WireEvent = BaseEvent | ({ type: string } & Record<string, unknown>);

function malformed(label: string): AppEvent {
  return {
    kind: 'run-error',
    message: `malformed wire event: ${label}`,
    code: 'non-retriable',
    retriable: false,
  };
}

function safeStringify(payload: unknown): string {
  try {
    const encoded = JSON.stringify(payload);
    if (typeof encoded === 'string') return encoded;
  } catch {
    // Use the guarded primitive conversion below.
  }
  return formatUnknown(payload, '');
}

function toVisibility(
  event: Record<string, unknown>,
  payload: unknown,
): Extract<AppEvent, { kind: 'visibility' }> {
  const wireClass = event.visClass;
  const cls = typeof wireClass === 'string' ? wireClass : '';
  return {
    kind: 'visibility',
    note: typeof payload === 'string' ? payload : safeStringify(payload),
    visClass: (VIS_CLASSES.has(cls) ? cls : 'modelVisible') as
      | 'modelVisible'
      | 'modelOnly'
      | 'localOnly',
  };
}

type WireObject = Record<string, unknown>;

function normalizeRunStarted(event: WireObject): AppEvent {
  const threadId = event.threadId;
  const runId = event.runId;
  return typeof threadId === 'string' && typeof runId === 'string'
    ? { kind: 'run-started', threadId, runId }
    : malformed('RUN_STARTED');
}

function normalizeRunFinished(event: WireObject): AppEvent {
  const threadId = event.threadId;
  const runId = event.runId;
  const wireUsage = event.usage;
  if (typeof threadId !== 'string' || typeof runId !== 'string') {
    return malformed('RUN_FINISHED');
  }
  const usage = TokenUsageSchema.safeParse(wireUsage);
  return {
    kind: 'run-finished',
    threadId,
    runId,
    ...(usage.success ? { usage: usage.data } : {}),
  };
}

function normalizeRunError(event: WireObject): AppEvent {
  const message = event.message;
  const code = event.code;
  const wireRetriable = event.retriable;
  if (
    typeof message !== 'string' ||
    (code !== undefined && typeof code !== 'string') ||
    (wireRetriable !== undefined && typeof wireRetriable !== 'boolean')
  ) {
    return malformed('RUN_ERROR');
  }
  const retriable =
    code !== undefined && NON_RETRIABLE_CODES.has(code)
      ? false
      : typeof wireRetriable === 'boolean'
        ? wireRetriable
        : true;
  return { kind: 'run-error', message, code, retriable };
}

function normalizeTextDelta(event: WireObject): AppEvent {
  const delta = event.delta;
  const messageId = event.messageId;
  if (typeof delta !== 'string' || (messageId !== undefined && typeof messageId !== 'string')) {
    return malformed('TEXT_MESSAGE_CONTENT');
  }
  return { kind: 'text-delta', messageId: messageId ?? '', delta };
}

function normalizeToolResult(event: WireObject): AppEvent {
  const toolCallId = event.toolCallId;
  const content = event.content;
  const toolName = event.toolName;
  const isError = event.isError;
  const error = event.error;
  const denied = event.denied;
  if (
    typeof toolCallId !== 'string' ||
    typeof content !== 'string' ||
    (toolName !== undefined && typeof toolName !== 'string') ||
    (isError !== undefined && typeof isError !== 'boolean') ||
    (error !== undefined && typeof error !== 'string') ||
    (denied !== undefined && typeof denied !== 'boolean')
  ) {
    return malformed('TOOL_CALL_RESULT');
  }
  return {
    kind: 'tool-result',
    toolCallId,
    toolName: toolName ?? '',
    content,
    isError: isError ?? false,
    ...(error === undefined ? {} : { error }),
    ...(denied === undefined ? {} : { denied }),
  };
}

function normalizeSnapshot(event: WireObject): AppEvent {
  const snapshot = event.snapshot;
  const parsed = JsonValueSchema.safeParse(snapshot);
  return parsed.success
    ? { kind: 'state-snapshot', snapshot: parsed.data }
    : malformed('STATE_SNAPSHOT');
}

function normalizeDelta(event: WireObject): AppEvent {
  const delta = event.delta;
  const parsed = JsonPatchArraySchema.safeParse(delta);
  return parsed.success ? { kind: 'state-delta', delta: parsed.data } : malformed('STATE_DELTA');
}

function normalizeCustom(event: WireObject): AppEvent {
  const name = event.name;
  if (typeof name !== 'string' || !Object.hasOwn(event, 'value')) {
    return malformed('CUSTOM');
  }
  const wireValue = event.value;
  const value = JsonValueSchema.safeParse(wireValue);
  return value.success ? toVisibility(event, value.data) : malformed('CUSTOM');
}

function normalizeRaw(event: WireObject): AppEvent {
  if (!Object.hasOwn(event, 'event')) return malformed('RAW');
  const payload = event.event;
  return toVisibility(event, payload);
}

function normalizeActivity(event: WireObject): AppEvent {
  const spec = event.spec;
  const parsed = AppSpecSchema.safeParse(spec);
  return parsed.success
    ? { kind: 'activity-snapshot', spec: parsed.data }
    : malformed('ACTIVITY_SNAPSHOT');
}

function normalizeObject(event: WireObject): AppEvent {
  const type = event.type;
  if (typeof type !== 'string') return malformed('non-string type discriminant');
  switch (type as EventType) {
    case EventType.RUN_STARTED:
      return normalizeRunStarted(event);
    case EventType.RUN_FINISHED:
      return normalizeRunFinished(event);
    case EventType.RUN_ERROR:
      return normalizeRunError(event);
    case EventType.TEXT_MESSAGE_CONTENT:
      return normalizeTextDelta(event);
    case EventType.TOOL_CALL_RESULT:
      return normalizeToolResult(event);
    case EventType.STATE_SNAPSHOT:
      return normalizeSnapshot(event);
    case EventType.STATE_DELTA:
      return normalizeDelta(event);
    case EventType.CUSTOM:
      return normalizeCustom(event);
    case EventType.RAW:
      return normalizeRaw(event);
    case EventType.ACTIVITY_SNAPSHOT:
      return normalizeActivity(event);
    default:
      return { kind: 'passthrough', rawType: type };
  }
}

/** The single total boundary where wire events become the internal union. */
export function toAppEvent(raw: unknown): AppEvent {
  try {
    if (raw === null || typeof raw !== 'object') {
      return { kind: 'passthrough', rawType: formatUnknown(raw, '') };
    }
    return normalizeObject(raw as Record<string, unknown>);
  } catch {
    return malformed('boundary access failed');
  }
}
