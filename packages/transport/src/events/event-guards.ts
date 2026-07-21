import { EventType, type BaseEvent } from '@ag-ui/core';

// The casing trap handled once — AG-UI ships SCREAMING_SNAKE `type` values; we narrow
// against the enum, never bare strings, so a 'state_delta'/'StateDelta' mismatch can't
// slip a guard.
type WithType<T extends EventType> = BaseEvent & { type: T } & Record<string, unknown>;

export const isStateDelta = (e: BaseEvent): e is WithType<EventType.STATE_DELTA> =>
  e.type === EventType.STATE_DELTA;
export const isStateSnapshot = (e: BaseEvent): e is WithType<EventType.STATE_SNAPSHOT> =>
  e.type === EventType.STATE_SNAPSHOT;
export const isToolCallResult = (e: BaseEvent): e is WithType<EventType.TOOL_CALL_RESULT> =>
  e.type === EventType.TOOL_CALL_RESULT;
export const isRunError = (e: BaseEvent): e is WithType<EventType.RUN_ERROR> =>
  e.type === EventType.RUN_ERROR;
export const isCustom = (e: BaseEvent): e is WithType<EventType.CUSTOM> =>
  e.type === EventType.CUSTOM;
export const isTextContent = (e: BaseEvent): e is WithType<EventType.TEXT_MESSAGE_CONTENT> =>
  e.type === EventType.TEXT_MESSAGE_CONTENT;
export const isRunStarted = (e: BaseEvent): e is WithType<EventType.RUN_STARTED> =>
  e.type === EventType.RUN_STARTED;
export const isRunFinished = (e: BaseEvent): e is WithType<EventType.RUN_FINISHED> =>
  e.type === EventType.RUN_FINISHED;
export const isActivitySnapshot = (e: BaseEvent): e is WithType<EventType.ACTIVITY_SNAPSHOT> =>
  e.type === EventType.ACTIVITY_SNAPSHOT;
