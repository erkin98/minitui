import { describe, it, expect } from 'vitest';
import {
  EventType,
  ToolCallStartEventSchema,
  ToolCallArgsEventSchema,
  ToolCallEndEventSchema,
  ToolCallResultEventSchema,
} from '@ag-ui/core';
import { buildActionUplink } from '../src/channels/action-uplink.js';

// C19: the old impl cast `{ …, args }` / `{ …, toolName, isError }` to BaseEvent,
// satisfying NEITHER wire — minitui's schema silently stripped the params and the
// AG-UI result was rejected for a missing messageId. These tests do a REAL schema
// parse (the gap the original duck-typed test never caught).

describe('action-uplink', () => {
  it('emits a schema-valid AG-UI tool-call lifecycle in canonical order', () => {
    const events = buildActionUplink({
      actionName: 'merge',
      params: { inputs: ['a.mp4', 'b.mp4'] },
      result: { content: 'done', isError: false },
      toolCallId: 'tc-1',
    });

    expect(events.map((e) => e.type)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
    ]);

    const [start, argsEvent, end, result] = events;
    expect(ToolCallStartEventSchema.safeParse(start).success).toBe(true);
    expect(ToolCallArgsEventSchema.safeParse(argsEvent).success).toBe(true);
    expect(ToolCallEndEventSchema.safeParse(end).success).toBe(true);
    // The result event failed AG-UI's own schema before the fix (missing messageId).
    expect(ToolCallResultEventSchema.safeParse(result).success).toBe(true);
  });

  it('carries the action params on the ARGS event (never silently stripped)', () => {
    const params = { inputs: ['a.mp4', 'b.mp4'], crf: 23 };
    const events = buildActionUplink({
      actionName: 'merge',
      params,
      result: { content: 'done', isError: false },
      toolCallId: 'tc-1',
    });
    const argsEvent = ToolCallArgsEventSchema.parse(events[1]);
    expect(JSON.parse(argsEvent.delta)).toEqual(params);
  });

  it('synthesizes the AG-UI-required messageId on the result', () => {
    const events = buildActionUplink({
      actionName: 'x',
      params: {},
      result: { content: 'ok', isError: false },
      toolCallId: 'tc-1',
    });
    const result = ToolCallResultEventSchema.parse(events[3]);
    expect(typeof result.messageId).toBe('string');
    expect(result.messageId.length).toBeGreaterThan(0);
  });

  it('honors an explicitly-provided messageId', () => {
    const events = buildActionUplink({
      actionName: 'x',
      params: {},
      result: { content: 'ok', isError: false },
      toolCallId: 'tc-1',
      messageId: 'msg-host',
    });
    const result = ToolCallResultEventSchema.parse(events[3]);
    expect(result.messageId).toBe('msg-host');
  });

  it('shares one toolCallId across the whole lifecycle', () => {
    const events = buildActionUplink({
      actionName: 'merge',
      params: {},
      result: { content: 'done', isError: false },
      toolCallId: 'tc-1',
    });
    const ids = new Set(events.map((e) => (e as { toolCallId?: string }).toolCallId));
    expect([...ids]).toEqual(['tc-1']);
  });

  it('generates a unique toolCallId when none is provided', () => {
    const events = buildActionUplink({
      actionName: 'x',
      params: {},
      result: { content: 'ok', isError: false },
    });
    const ids = new Set(events.map((e) => (e as { toolCallId?: string }).toolCallId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeTruthy();
  });

  it('preserves the error flag on the result (passthrough extra)', () => {
    const events = buildActionUplink({
      actionName: 'x',
      params: {},
      result: { content: 'boom', isError: true },
    });
    const result = events[3];
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});
