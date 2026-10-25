import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { ModelProvider } from '../src/provider/provider-port.js';
import type { ProviderChunk } from '../src/provider/provider-types.js';
import type { MinituiEvent } from '../src/events/event-types.js';
import type { ToolCallRequest, ToolCallResult, ToolDispatchPort } from '../src/ports/index.js';
import {
  makeSession,
  scriptedModel,
  textTurn,
  toolCallTurn,
  within,
  type CallScript,
} from './helpers/sdk-model.js';

const MAX_TIMER = 2 ** 31 - 1;
const model = scriptedModel([]).model;
const build = (config: Record<string, number>) => () => makeSession({ model, config });

describe('numeric config is validated when the session is built', () => {
  const BAD: ReadonlyArray<readonly [field: string, values: readonly number[]]> = [
    ['stepCeiling', [0, -1, 1.5, Number.NaN, 1001]],
    ['turnTimeoutMs', [0, -1, Infinity, Number.NaN, 2 ** 31]],
    ['idleTimeoutMs', [0, -1, Infinity, 2 ** 31, 0.5, Number.NaN]],
    ['streamMaxRetries', [-1, 11, 1.5, Number.NaN]],
  ];
  const BAD_CASES = BAD.flatMap(([field, values]) =>
    values.map((value) => [field, value] as const),
  );

  it('has twenty bad values to check', () => {
    expect(BAD_CASES).toHaveLength(20);
  });

  it.each(BAD_CASES)('%s of %s throws a RangeError that names the field', (field, value) => {
    expect(build({ [field]: value })).toThrowError(RangeError);
    expect(build({ [field]: value })).toThrowError(new RegExp(field));
  });

  it.each([
    ['stepCeiling', 1],
    ['stepCeiling', 1000],
    ['turnTimeoutMs', MAX_TIMER],
    ['idleTimeoutMs', MAX_TIMER],
    ['streamMaxRetries', 0],
    ['streamMaxRetries', 10],
  ] as const)('accepts %s of %s', (field, value) => {
    expect(build({ [field]: value })).not.toThrow();
  });

  it('accepts an empty config', () => {
    expect(() => makeSession({ model, config: {} })).not.toThrow();
    expect(() => makeSession({ model })).not.toThrow();
  });

  it.each([0, 2 ** 31])('maxOutputTokens of %s throws a RangeError that names it', (value) => {
    expect(build({ maxOutputTokens: value })).toThrowError(RangeError);
    expect(build({ maxOutputTokens: value })).toThrowError(/maxOutputTokens/);
  });

  it.each([1, MAX_TIMER])('maxOutputTokens of %s builds the session', (value) => {
    expect(build({ maxOutputTokens: value })).not.toThrow();
  });
});

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
          content: 'done',
          isError: false,
        });
      },
    },
  };
}

async function run(session: ReturnType<typeof makeSession>): Promise<MinituiEvent[]> {
  const out: MinituiEvent[] = [];
  await within(
    (async () => {
      for await (const ev of session.submit('go')) out.push(ev);
    })(),
    8000,
    'the turn',
  );
  return out;
}

describe('the tool set has no prototype', () => {
  it.each([
    'constructor',
    'toString',
    'hasOwnProperty',
    'valueOf',
    '__proto__',
    'CONSTRUCTOR',
    'nothingLikeIt',
  ])(
    'a call to %s is an unknown tool: reported back to the model, nothing dispatched',
    async (name) => {
      const scripts: CallScript[] = [
        { chunks: toolCallTurn('c1', name, {}) },
        { chunks: textTurn('recovered') },
      ];
      const { model: scripted, calls } = scriptedModel(scripts);
      const dispatch = recordingDispatch();
      const events = await run(
        makeSession({ model: scripted, tools: [ffmpeg], toolDispatch: dispatch.port }),
      );
      expect(dispatch.requests).toEqual([]);
      expect(calls).toHaveLength(2); // the model got a second step
      expect(JSON.stringify(calls[1]?.prompt)).toContain('Invalid tool call');
      expect(events.at(-1)?.type).toBe('RUN_FINISHED');
    },
  );

  it('a call to RUN is dispatched as run', async () => {
    const run1 = { name: 'run', description: 'run it', inputSchema: z.object({ a: z.number() }) };
    const { model: scripted } = scriptedModel([
      { chunks: toolCallTurn('c1', 'RUN', { a: 1 }) },
      { chunks: textTurn('done') },
    ]);
    const dispatch = recordingDispatch();
    await run(makeSession({ model: scripted, tools: [run1], toolDispatch: dispatch.port }));
    expect(dispatch.requests.map((r) => r.toolName)).toEqual(['run']);
  });

  it('a direct call to the reroute tool dispatches nothing', async () => {
    const { model: scripted } = scriptedModel([
      { chunks: toolCallTurn('c1', 'invalid', { tool: 'x', error: 'y' }) },
      { chunks: textTurn('done') },
    ]);
    const dispatch = recordingDispatch();
    const events = await run(
      makeSession({ model: scripted, tools: [ffmpeg], toolDispatch: dispatch.port }),
    );
    expect(dispatch.requests).toEqual([]);
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
  });
});

describe('a failed tool looks the same on both loops', () => {
  const RESULTS: ReadonlyArray<
    readonly [label: string, result: Omit<ToolCallResult, 'toolCallId' | 'toolName'>]
  > = [
    [
      'a failed dispatch with partial output',
      {
        ok: false,
        content: 'merged 1 of 3 into /home/alice/out.mp4',
        isError: true,
        error: 'disk full at /home/alice/out.mp4',
      },
    ],
    ['a host refusal', { ok: false, content: '', isError: false, denied: true }],
  ];
  const policy = { homeDir: '/home/alice', tmpDir: '/tmp' };

  it.each(RESULTS)('%s', async (_label, outcome) => {
    const dispatch: ToolDispatchPort = {
      dispatch: (req) =>
        Promise.resolve({ toolCallId: req.toolCallId, toolName: req.toolName, ...outcome }),
    };
    const results = (events: readonly MinituiEvent[]): MinituiEvent[] =>
      events.filter((ev) => ev.type === 'TOOL_CALL_RESULT');

    const { model: scripted } = scriptedModel([
      { chunks: toolCallTurn('c1', 'ffmpeg', { a: 1 }) },
      { chunks: textTurn('sorry') },
    ]);
    const sdk = results(
      await run(
        makeSession({
          model: scripted,
          tools: [ffmpeg],
          toolDispatch: dispatch,
          config: { redactionPolicy: policy },
        }),
      ),
    );

    const provider: ModelProvider = {
      id: 'scripted',
      async *streamChat() {
        const call: ProviderChunk = {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'ffmpeg',
          input: { a: 1 },
        };
        yield call;
        yield { type: 'finish', reason: 'stop' };
      },
    };
    const other = results(
      await run(
        makeSession({
          model: 'm',
          provider,
          tools: [ffmpeg],
          toolDispatch: dispatch,
          config: { redactionPolicy: policy },
        }),
      ),
    );

    expect(sdk).toHaveLength(1);
    expect(sdk).toEqual(other);
    expect(JSON.stringify(sdk)).not.toContain('/home/alice');
  });
});
