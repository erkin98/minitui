import { EventType } from '@ag-ui/core';
import { createReadonlySet } from '../collections/readonly-set.js';

/** The AG-UI EventType families transport normalizes; everything else passes through opaque.
 *  MUST stay in lockstep with the toAppEvent switch — any kind handled there appears here. */
export const CONSUMED_KINDS: ReadonlySet<EventType> = createReadonlySet([
  EventType.RUN_STARTED,
  EventType.RUN_FINISHED,
  EventType.RUN_ERROR,
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TOOL_CALL_START,
  EventType.TOOL_CALL_RESULT,
  EventType.STATE_SNAPSHOT,
  EventType.STATE_DELTA,
  EventType.CUSTOM,
  EventType.RAW,
  EventType.ACTIVITY_SNAPSHOT,
]);
