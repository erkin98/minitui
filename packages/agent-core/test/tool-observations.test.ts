import { describe, it, expect } from 'vitest';
import { streamText } from 'ai';
import { z } from 'zod';
import { runTurns, runProviderStream } from '../src/session/stream-turns.js';
import { createAsyncEventQueue } from '../src/events/event-stream.js';
import { createConversation } from '../src/session/conversation.js';
import type { MinituiEvent } from '../src/events/event-types.js';
import type { ToolCallResult, ToolDispatchPort } from '../src/ports/index.js';
import type { ModelProvider } from '../src/provider/provider-port.js';
import { scriptedModel } from './helpers/sdk-model.js';

// The observations both loops make of a tool call that did not come from a plain successful dispatch.

const tools = [{ name: 'ffmpeg', description: 'merge', inputSchema: z.object({ a: z.number() }) }];

const dispatch: ToolDispatchPort = {
  dispatch: async (req): Promise<ToolCallResult> => ({
    toolCallId: req.toolCallId,
    ok: true,
    toolName: req.toolName,
    content: 'done',
    isError: false,
  }),
};

describe('tool observations that never crossed a successful dispatch', () => {
  it('redacts a tool error that never crossed a dispatch, on the installed SDK loop', async () => {
    // A provider-run tool that fails reaches the loop as a tool-error part whose error is the provider's
    // own text: nothing on the dispatch side redacted it, so the loop's own reading must.
    const secret = 'sk-ant-api03-cccccccccccccccccccccccc';
    const scripted = scriptedModel([
      {
        chunks: [
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-result',
            toolCallId: 'p1',
            toolName: 'serverTool',
            result: `failed reading /home/alice/.netrc with ${secret}`,
            isError: true,
            providerExecuted: true,
          },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
      },
    ]);
    const queue = createAsyncEventQueue<MinituiEvent>();
    const done = runTurns({
      conversation: createConversation([{ role: 'user', content: 'merge' }]),
      threadId: 'tid',
      runId: 'run-1',
      queue,
      signal: new AbortController().signal,
      deps: {
        streamTextImpl: streamText,
        toolDispatch: dispatch,
        tools,
        model: scripted.model,
        redactionPolicy: { homeDir: '/home/alice', tmpDir: '/tmp' },
      },
    }).then(() => queue.close());
    const out: MinituiEvent[] = [];
    for await (const e of queue) out.push(e);
    await done;
    const result = out.find((e) => e.type === 'TOOL_CALL_RESULT');
    expect(result).toMatchObject({
      type: 'TOOL_CALL_RESULT',
      toolCallId: 'p1',
      isError: true,
      content: 'failed reading ~/.netrc with [redacted-secret]',
      error: 'failed reading ~/.netrc with [redacted-secret]',
    });
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  it('redacts the output of a scripted tool-result chunk on the non-SDK loop', async () => {
    const secret = 'sk-ant-api03-dddddddddddddddddddddddd';
    const queue = createAsyncEventQueue<MinituiEvent>();
    const scripted: ModelProvider = {
      id: 'scripted',
      async *streamChat() {
        yield {
          type: 'tool-result',
          toolCallId: 't11',
          toolName: 'ffprobe',
          output: `probe of /home/alice/a.mp4 used ${secret}`,
          isError: false,
        };
        yield { type: 'finish', reason: 'stop' };
      },
    };
    const done = runProviderStream({
      provider: scripted,
      conversation: createConversation([{ role: 'user', content: 'merge' }]),
      threadId: 'tid',
      runId: 'run-1',
      model: 'test-model',
      tools,
      toolDispatch: dispatch,
      redactionPolicy: { homeDir: '/home/alice', tmpDir: '/tmp' },
      queue,
      signal: new AbortController().signal,
    }).then(() => queue.close());
    const out: MinituiEvent[] = [];
    for await (const e of queue) out.push(e);
    await done;
    expect(out.find((e) => e.type === 'TOOL_CALL_RESULT')).toMatchObject({
      content: 'probe of ~/a.mp4 used [redacted-secret]',
      isError: false,
    });
  });
});

describe('the non-SDK loop checks a scripted tool call before it dispatches', () => {
  // Runs one scripted tool call through the non-SDK loop and returns the events and the dispatched names.
  async function runOneCall(
    call: { toolName: string; input: unknown },
    port?: ToolDispatchPort,
  ): Promise<{ events: MinituiEvent[]; dispatched: string[] }> {
    const dispatched: string[] = [];
    const recording: ToolDispatchPort = {
      dispatch: async (req, signal) => {
        dispatched.push(req.toolName);
        return (port ?? dispatch).dispatch(req, signal);
      },
    };
    const scripted: ModelProvider = {
      id: 'scripted',
      async *streamChat() {
        yield { type: 'tool-call', toolCallId: 'c1', ...call };
        yield { type: 'text', text: 'after the call' };
        yield { type: 'finish', reason: 'stop' };
      },
    };
    const queue = createAsyncEventQueue<MinituiEvent>();
    const done = runProviderStream({
      provider: scripted,
      conversation: createConversation([{ role: 'user', content: 'merge' }]),
      threadId: 'tid',
      runId: 'run-1',
      model: 'test-model',
      tools,
      toolDispatch: recording,
      redactionPolicy: { homeDir: '/home/alice', tmpDir: '/tmp' },
      queue,
      signal: new AbortController().signal,
    }).then(() => queue.close());
    const events: MinituiEvent[] = [];
    for await (const e of queue) events.push(e);
    await done;
    return { events, dispatched };
  }

  it('turns a rejected dispatch into a redacted failed result and keeps the turn going', async () => {
    const secret = 'sk-ant-api03-ffffffffffffffffffffffff';
    const rejecting: ToolDispatchPort = {
      dispatch: async () => {
        throw new Error(`boom in /home/alice/run with ${secret}`);
      },
    };
    const { events } = await runOneCall({ toolName: 'ffmpeg', input: { a: 1 } }, rejecting);
    expect(events.map((e) => e.type)).toEqual([
      'TOOL_CALL_START',
      'TOOL_CALL_RESULT',
      'TEXT_MESSAGE_CONTENT',
      'RUN_FINISHED',
    ]);
    expect(events[1]).toEqual({
      type: 'TOOL_CALL_RESULT',
      toolCallId: 'c1',
      toolName: 'ffmpeg',
      content: '',
      isError: true,
      error: 'boom in ~/run with [redacted-secret]',
    });
  });

  it('refuses a tool name that is not one of the session tools, without a dispatch', async () => {
    const { events, dispatched } = await runOneCall({ toolName: 'merge', input: { a: 1 } });
    expect(dispatched).toEqual([]);
    expect(events[1]).toEqual({
      type: 'TOOL_CALL_RESULT',
      toolCallId: 'c1',
      toolName: 'merge',
      content: '',
      isError: true,
      error: 'unknown tool; valid tools: ffmpeg',
    });
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
  });

  it('refuses an input the tool schema rejects, without a dispatch', async () => {
    const { events, dispatched } = await runOneCall({ toolName: 'ffmpeg', input: { a: 'one' } });
    expect(dispatched).toEqual([]);
    expect(events[1]).toMatchObject({
      type: 'TOOL_CALL_RESULT',
      isError: true,
      error: 'invalid input for tool ffmpeg',
    });
  });

  it('dispatches the parsed input of a known tool', async () => {
    const { events, dispatched } = await runOneCall({ toolName: 'ffmpeg', input: { a: 1 } });
    expect(dispatched).toEqual(['ffmpeg']);
    expect(events[1]).toMatchObject({ type: 'TOOL_CALL_RESULT', isError: false, content: 'done' });
  });
});
