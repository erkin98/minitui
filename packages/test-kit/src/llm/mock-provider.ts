// A subset of agent-core's provider chunk variants, field for field (`type` is the discriminant), declared
// here because test-kit may not import agent-core. TypeScript checks the shapes where a MockLlmProvider is
// passed as a ModelProvider. Members that agent-core declares as bare optionals stay bare here.
export type MockChunk =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'tool-result';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly output: unknown;
      readonly isError: boolean;
      readonly error?: string;
    }
  // A finish whose reason is not `stop` ends the run as the model loop's endings table says: `length` and
  // `content-filter` end it as non-retriable, `tool-calls` on the final part ends it at the tool-call
  // limit, `error` takes the retriable failed-generation path; only `stop` and `other` finish the run.
  | {
      readonly type: 'finish';
      readonly reason: 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error' | 'other';
      readonly usage?: { inputTokens: number; outputTokens: number } | undefined;
    }
  | {
      readonly type: 'error';
      readonly message: string;
      readonly retriable: boolean;
      readonly retryAfterMs?: number;
    };

export interface MockProviderOptions {
  readonly id?: string | undefined;
  readonly delayMs?: number | undefined;
}

function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

/**
 * A scripted model provider backed by a real async generator: it replays its chunks in order whatever the
 * prompt, records every request it is driven with (so a second turn, such as a repair, is observable), and
 * stops with an AbortError when the signal fires.
 */
export class MockLlmProvider {
  readonly id: string;
  private readonly script: readonly MockChunk[];
  private readonly delayMs: number;
  private received: readonly unknown[] = [];

  constructor(script: readonly MockChunk[], opts: MockProviderOptions = {}) {
    this.id = opts.id ?? 'mock-llm';
    this.script = script;
    this.delayMs = opts.delayMs ?? 0;
  }

  receivedRequests(): readonly unknown[] {
    return this.received;
  }

  async *streamChat(req: unknown, signal: AbortSignal): AsyncGenerator<MockChunk> {
    this.received = [...this.received, req];
    for (const chunk of this.script) {
      if (signal.aborted) throw abortError();
      if (this.delayMs > 0) await sleep(this.delayMs, signal);
      if (signal.aborted) throw abortError();
      yield chunk;
    }
  }
}
