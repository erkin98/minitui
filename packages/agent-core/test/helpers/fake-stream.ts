import type { ModelStreamPart, StreamTextFn } from '../../src/provider/stream-part.js';

export type { ModelStreamPart, StreamTextFn };

/** What one call of the stream function was given. */
export type StreamOptions = Parameters<StreamTextFn>[0];

/** A stream function that yields the given parts in order and calls no tool. */
export function partsStream(parts: readonly ModelStreamPart[]): StreamTextFn {
  return () => ({
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
  });
}

/**
 * Runs one tool of the call's tool set the way the SDK does, and reports how it settled: its output, or
 * the value it threw (a failed dispatch throws by design).
 */
export async function runTool(
  options: StreamOptions,
  name: string,
  input: unknown,
  toolCallId: string,
): Promise<{ readonly output: unknown } | { readonly error: unknown }> {
  const execute = options.tools?.[name]?.execute;
  if (execute === undefined) throw new Error(`no tool named ${name}`);
  try {
    const output: unknown = await execute(input, { toolCallId, messages: [] });
    return { output };
  } catch (error) {
    return { error };
  }
}

/** One tool call the fake stream runs. */
export interface FakeCall {
  readonly name: string;
  readonly input: unknown;
  readonly toolCallId: string;
}

/**
 * A stream function that runs each call's tool in order the way the SDK does, yields its tool-result (or,
 * when the tool threw, its tool-error), then a stop finish. `settled` sees how each call settled.
 */
export function toolCallsThenFinish(
  calls: readonly FakeCall[],
  settled?: (outcome: { readonly output: unknown } | { readonly error: unknown }) => void,
): StreamTextFn {
  return (options) => ({
    fullStream: (async function* () {
      for (const call of calls) {
        const outcome = await runTool(options, call.name, call.input, call.toolCallId);
        settled?.(outcome);
        const base = { toolCallId: call.toolCallId, toolName: call.name, input: call.input };
        yield 'error' in outcome
          ? { type: 'tool-error', ...base, error: outcome.error }
          : { type: 'tool-result', ...base, output: outcome.output };
      }
      yield { type: 'finish', finishReason: 'stop' };
    })(),
  });
}
