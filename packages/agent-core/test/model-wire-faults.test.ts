import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAnthropicModel } from '../src/provider/ai-sdk-provider.js';
import type { MinituiEvent } from '../src/events/event-types.js';
import type { ToolCallRequest, ToolDispatchPort } from '../src/ports/index.js';
import { makeSession } from './helpers/sdk-model.js';
import {
  cutAfterTextReply,
  cutBeforeOutputReply,
  fieldOf,
  recordingFetch,
  textReply,
  toolUseReply,
} from './helpers/anthropic-wire.js';

// Turns through the real streamText and the real provider package over a recording fetch, for what the
// network and the model can do wrong: a connection cut mid-reply, and a tool call the model gets wrong.

const ffmpeg = { name: 'ffmpeg', description: 'merge', inputSchema: z.object({ a: z.number() }) };

function recordingDispatch(): { port: ToolDispatchPort; requests: ToolCallRequest[] } {
  const requests: ToolCallRequest[] = [];
  return {
    requests,
    port: {
      dispatch: (req) => {
        requests.push(req);
        return Promise.resolve({
          toolCallId: req.toolCallId,
          toolName: req.toolName,
          ok: true,
          content: 'merged',
          isError: false,
        });
      },
    },
  };
}

async function turnOver(
  replies: readonly string[],
  opts: { readonly tools?: (typeof ffmpeg)[]; readonly toolDispatch?: ToolDispatchPort } = {},
): Promise<{ readonly events: readonly MinituiEvent[]; readonly bodies: readonly unknown[] }> {
  const wire = recordingFetch(replies);
  const model = createAnthropicModel('test-model', { apiKey: 'test', fetch: wire.fetch });
  const session = makeSession({
    model,
    tools: opts.tools ?? [],
    ...(opts.toolDispatch !== undefined ? { toolDispatch: opts.toolDispatch } : {}),
    config: { maxOutputTokens: 1000 },
  });
  const events: MinituiEvent[] = [];
  for await (const ev of session.submit('merge the clips')) events.push(ev);
  return { events, bodies: wire.requests.map((r) => r.body) };
}

// The content blocks of every message in a request body.
function blocksOf(body: unknown): readonly unknown[] {
  const messages = fieldOf(body, 'messages');
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((m) => {
    const content = fieldOf(m, 'content');
    return Array.isArray(content) ? content : [];
  });
}

const toolNamesOf = (body: unknown): readonly unknown[] => {
  const tools = fieldOf(body, 'tools');
  return Array.isArray(tools) ? tools.map((t) => fieldOf(t, 'name')) : [];
};

describe('a connection cut mid-reply', () => {
  it('after some text: the run ends as an interrupted generation, retriable, and is not re-run', async () => {
    const { events, bodies } = await turnOver([cutAfterTextReply('hel'), textReply('hello')]);
    expect(bodies).toHaveLength(1);
    expect(events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')).not.toHaveLength(0);
    expect(events.at(-1)).toEqual({
      type: 'RUN_ERROR',
      message: 'the provider interrupted the generation',
    });
  });

  it('before any output: the turn is re-run and finishes', async () => {
    const { events, bodies } = await turnOver([cutBeforeOutputReply(), textReply('hello')]);
    expect(bodies).toHaveLength(2);
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
  });
});

describe('a tool call the model gets wrong, through the provider package', () => {
  it('an unknown tool is reported back to the model as a failed tool result, and nothing is dispatched', async () => {
    const dispatch = recordingDispatch();
    const { events, bodies } = await turnOver(
      [toolUseReply('delete_everything', {}), textReply('done')],
      { tools: [ffmpeg], toolDispatch: dispatch.port },
    );
    expect(dispatch.requests).toEqual([]);
    expect(bodies).toHaveLength(2);
    expect(bodies.map(toolNamesOf)).toEqual([['ffmpeg'], ['ffmpeg']]);
    const result = blocksOf(bodies[1]).find((b) => fieldOf(b, 'type') === 'tool_result');
    expect(fieldOf(result, 'is_error')).toBe(true);
    expect(JSON.stringify(result)).toContain("unavailable tool 'delete_everything'");
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
  });

  it('a wrong-case name is fixed and dispatched as the catalog tool', async () => {
    const dispatch = recordingDispatch();
    const { events } = await turnOver([toolUseReply('FFMPEG', { a: 1 }), textReply('done')], {
      tools: [ffmpeg],
      toolDispatch: dispatch.port,
    });
    expect(dispatch.requests.map((r) => [r.toolName, r.args])).toEqual([['ffmpeg', { a: 1 }]]);
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
  });
});
