import type { AgentEvent } from '@minitui/types';

/**
 * The event vocabulary agent-core emits. agent-core OWNS this alias; the underlying shapes are
 * the @minitui/types AG-UI AgentEvent union (RUN_*, STATE_*, TEXT_MESSAGE_CONTENT, TOOL_CALL_*,
 * ACTIVITY_SNAPSHOT, CUSTOM). This is exactly what createLocalAgentPort's genFactory yields and
 * toAppEvent normalizes — agent-core does NOT redefine the shapes.
 */
export type MinituiEvent = AgentEvent;
