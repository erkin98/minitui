import { MockLlmProvider, type MockChunk, type MockProviderOptions } from './mock-provider.js';

type FinishReason = Extract<MockChunk, { type: 'finish' }>['reason'];
type ToolCallChunk = Extract<MockChunk, { type: 'tool-call' }>;

/** An immutable fluent builder over an ordered chunk script; every step returns a new builder. */
export class ScriptedRun {
  constructor(
    private readonly steps: readonly MockChunk[] = [],
    private readonly lastCallId: string | undefined = undefined,
    private readonly seq = 0,
  ) {}

  private with(chunk: MockChunk, lastCallId = this.lastCallId, seq = this.seq): ScriptedRun {
    return new ScriptedRun([...this.steps, chunk], lastCallId, seq);
  }

  text(text: string): ScriptedRun {
    return this.with({ type: 'text', text });
  }

  toolCall(toolName: string, input: unknown, id?: string): ScriptedRun {
    const seq = this.seq + 1;
    const toolCallId = id ?? `t${seq}`;
    return this.with({ type: 'tool-call', toolCallId, toolName, input }, toolCallId, seq);
  }

  /** The result of the named call, or of the last call when `id` is undefined; it carries that call's tool name. */
  toolResult(id: string | undefined, output: unknown, isError = false): ScriptedRun {
    const toolCallId = id ?? this.lastCallId;
    if (toolCallId === undefined) {
      throw new Error('toolResult: no toolCallId and no preceding toolCall');
    }
    const call = [...this.steps]
      .reverse()
      .find((c): c is ToolCallChunk => c.type === 'tool-call' && c.toolCallId === toolCallId);
    const toolName = call?.toolName ?? toolCallId;
    return this.with({ type: 'tool-result', toolCallId, toolName, output, isError });
  }

  finish(reason: FinishReason = 'stop'): ScriptedRun {
    return this.with({ type: 'finish', reason });
  }

  error(message: string, retriable: boolean, retryAfterMs?: number): ScriptedRun {
    return this.with({
      type: 'error',
      message,
      retriable,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  chunks(): readonly MockChunk[] {
    return this.steps;
  }

  provider(opts?: MockProviderOptions): MockLlmProvider {
    return new MockLlmProvider(this.steps, opts);
  }
}

/** The zero-argument entry the fixtures and tests chain from. */
export function scriptedRun(): ScriptedRun {
  return new ScriptedRun();
}
