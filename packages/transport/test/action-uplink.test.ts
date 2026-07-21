import { describe, it, expect } from 'vitest';
import { EventType } from '@ag-ui/core';
import { buildActionUplink } from '../src/channels/action-uplink.js';

describe('action-uplink', () => {
  it('synthesizes a tool-call + result sharing one toolCallId', () => {
    const { toolCall, result } = buildActionUplink({
      actionName: 'merge',
      params: { inputs: ['a.mp4', 'b.mp4'] },
      result: { content: 'done', isError: false },
      toolCallId: 'tc-1',
    });
    expect(toolCall.type).toBe(EventType.TOOL_CALL_START);
    expect((toolCall as Record<string, unknown>).toolCallId).toBe('tc-1');
    expect((toolCall as Record<string, unknown>).toolCallName).toBe('merge');
    expect(result.type).toBe(EventType.TOOL_CALL_RESULT);
    expect((result as Record<string, unknown>).toolCallId).toBe('tc-1');
    expect((result as Record<string, unknown>).toolName).toBe('merge');
    expect((result as Record<string, unknown>).content).toBe('done');
  });

  it('generates a toolCallId when none is provided', () => {
    const { toolCall, result } = buildActionUplink({
      actionName: 'x',
      params: {},
      result: { content: 'ok', isError: false },
    });
    const id = (toolCall as Record<string, unknown>).toolCallId;
    expect(id).toBeTruthy();
    expect((result as Record<string, unknown>).toolCallId).toBe(id);
  });

  it('marks an error result isError', () => {
    const { result } = buildActionUplink({
      actionName: 'x',
      params: {},
      result: { content: 'boom', isError: true },
    });
    expect((result as Record<string, unknown>).isError).toBe(true);
  });
});
