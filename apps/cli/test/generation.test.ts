import { describe, it, expect } from 'vitest';
import type { MinituiEvent } from '@minitui/agent-core';
import { videoMergeCatalog } from '@minitui/catalog';
import { buildValidationEnvelope, composeValidation, type CapabilityProvider } from '@minitui/spec';
import type { AppEvent, RunHandle } from '@minitui/transport';
import {
  MAX_GEN_ATTEMPTS,
  PREVIOUS_ATTEMPT_CAP,
  ProviderRunError,
  composeRegenerationPrompt,
  createGenerationContext,
  repairTextOf,
  specTextOf,
  summarizeEnvelope,
  teeText,
} from '../src/generation.js';

function streamOf(...chunks: string[]): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: () => {
          const value = chunks[index];
          index += 1;
          return Promise.resolve(
            value === undefined
              ? { done: true as const, value: undefined }
              : { done: false as const, value },
          );
        },
      };
    },
  };
}

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of source) out.push(chunk);
  return out;
}

function handleOf(...events: AppEvent[]): RunHandle {
  return {
    events: (async function* () {
      await Promise.resolve();
      for (const event of events) yield event;
    })(),
    abort: () => {},
    signal: new AbortController().signal,
  };
}

const idle: CapabilityProvider = {
  listEncoders: () => Promise.resolve([]),
  listCodecs: () => Promise.resolve([]),
  listFilters: () => Promise.resolve([]),
  statFile: () => Promise.resolve({ exists: false, readable: false, isFile: false }),
};

describe('MAX_GEN_ATTEMPTS', () => {
  it('equals the number of passes the real validation loop makes before it gives up', async () => {
    let regenerations = 0;
    const result = await composeValidation({
      stream: streamOf(''),
      catalog: videoMergeCatalog,
      capabilities: idle,
      regenerate: () => {
        regenerations += 1;
        return streamOf('');
      },
    });
    expect(result.ok).toBe(false);
    expect(regenerations + 1).toBe(MAX_GEN_ATTEMPTS);
    if (!result.ok) expect(result.lastEnvelope.attempt).toBe(MAX_GEN_ATTEMPTS);
  });
});

describe('composeRegenerationPrompt', () => {
  it('carries the intent, the previous reply and the loop reprompt', () => {
    const prompt = composeRegenerationPrompt({
      intent: 'merge two clips',
      previousText: 'my last reply',
      reprompt: 'fix the root',
    });
    expect(prompt).toContain('merge two clips');
    expect(prompt).toContain('my last reply');
    expect(prompt).toContain('fix the root');
  });

  it('says so when there was no previous reply', () => {
    const prompt = composeRegenerationPrompt({ intent: 'i', previousText: '', reprompt: 'r' });
    expect(prompt).toContain('(empty)');
  });

  it('keeps the head of a long previous reply', () => {
    const long = 'a'.repeat(PREVIOUS_ATTEMPT_CAP) + 'TAIL';
    const prompt = composeRegenerationPrompt({ intent: 'i', previousText: long, reprompt: 'r' });
    expect(prompt).not.toContain('TAIL');
    expect(prompt).toContain('a'.repeat(PREVIOUS_ATTEMPT_CAP));
  });
});

describe('teeText', () => {
  it('passes the chunks through unchanged and records them', async () => {
    const context = createGenerationContext();
    expect(await collect(teeText(streamOf('ab', 'cd'), context))).toEqual(['ab', 'cd']);
    expect(context.previousText).toBe('abcd');
  });

  it('starts a new record for each run', async () => {
    const context = createGenerationContext();
    await collect(teeText(streamOf('first'), context));
    await collect(teeText(streamOf('second'), context));
    expect(context.previousText).toBe('second');
  });

  it('stops recording at the cap and still passes everything on', async () => {
    const context = createGenerationContext();
    const big = 'x'.repeat(PREVIOUS_ATTEMPT_CAP);
    const seen = await collect(teeText(streamOf(big, 'more'), context));
    expect(seen).toEqual([big, 'more']);
    expect(context.previousText).toBe(big);
  });
});

describe('specTextOf', () => {
  it('yields the text deltas and ignores other events', async () => {
    const handle = handleOf(
      { kind: 'text-delta', messageId: 'm', delta: 'one' },
      { kind: 'tool-start', toolCallId: 't', toolName: 'x' },
      { kind: 'text-delta', messageId: 'm', delta: 'two' },
    );
    expect(await collect(specTextOf(handle))).toEqual(['one', 'two']);
  });

  it('throws a ProviderRunError on a run-error, carrying its code and whether it can be retried', async () => {
    const handle = handleOf({
      kind: 'run-error',
      message: 'overloaded',
      code: 'overloaded',
      retriable: true,
    });
    const failure = await collect(specTextOf(handle)).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ProviderRunError);
    expect(failure).toMatchObject({ message: 'overloaded', code: 'overloaded', retriable: true });
  });

  it('reports the token usage of a finished run and leaves the text stream alone', async () => {
    const usage: Array<{ inputTokens: number; outputTokens: number }> = [];
    const handle = handleOf(
      { kind: 'text-delta', messageId: 'm', delta: 'x' },
      {
        kind: 'run-finished',
        threadId: 't',
        runId: 'r',
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    );
    expect(await collect(specTextOf(handle, (u) => usage.push(u)))).toEqual(['x']);
    expect(usage).toEqual([{ inputTokens: 10, outputTokens: 5 }]);
  });

  it('reports nothing when the finished run carries no usage', async () => {
    const usage: unknown[] = [];
    const handle = handleOf({ kind: 'run-finished', threadId: 't', runId: 'r' });
    await collect(specTextOf(handle, (u) => usage.push(u)));
    expect(usage).toEqual([]);
  });
});

async function* eventsOf(...events: MinituiEvent[]): AsyncGenerator<MinituiEvent> {
  await Promise.resolve();
  for (const event of events) yield event;
}

describe('repairTextOf', () => {
  it('yields the message deltas of a repair turn', async () => {
    const events = eventsOf(
      { type: 'RUN_STARTED', threadId: 't', runId: 'r' },
      { type: 'TEXT_MESSAGE_CONTENT', delta: 'patch' },
    );
    expect(await collect(repairTextOf(events))).toEqual(['patch']);
  });

  it('throws a ProviderRunError on a RUN_ERROR, retriable unless the code says it is not', async () => {
    const retriable = await collect(
      repairTextOf(eventsOf({ type: 'RUN_ERROR', message: 'down', code: 'overloaded' })),
    ).catch((e: unknown) => e);
    expect(retriable).toMatchObject({ message: 'down', retriable: true });
    const final = await collect(
      repairTextOf(eventsOf({ type: 'RUN_ERROR', message: 'bad key', code: 'non-retriable' })),
    ).catch((e: unknown) => e);
    expect(final).toMatchObject({ message: 'bad key', retriable: false });
  });
});

describe('summarizeEnvelope', () => {
  const first = buildValidationEnvelope({
    attempt: 1,
    structural: [{ severity: 'error', code: 'empty_spec', message: 'the spec is empty' }],
    semantic: [],
  });
  const last = buildValidationEnvelope({
    attempt: 6,
    structural: [],
    semantic: [{ severity: 'error', code: 'missing_file', message: 'no such file' }],
  });

  it('names the number of attempts of the last failure and shows both failures', () => {
    const text = summarizeEnvelope(first, last);
    expect(text).toContain('exhausted 6 attempts');
    expect(text).toContain('first failure structural');
    expect(text).toContain('the spec is empty');
    expect(text).toContain('last failure semantic');
    expect(text).toContain('no such file');
  });

  it('removes the control characters that JSON escaping leaves raw from the model-influenced issue text', () => {
    // JSON.stringify escapes ESC itself but leaves DEL and the C1 range (CSI is U+009B) as they are, and a
    // terminal acts on both.
    const csi = String.fromCharCode(0x9b);
    const del = String.fromCharCode(0x7f);
    const hostile = buildValidationEnvelope({
      attempt: 2,
      structural: [{ severity: 'error', code: 'empty_spec', message: `bad ${csi}2J${del}end` }],
      semantic: [],
    });
    const text = summarizeEnvelope(hostile, hostile);
    expect(text).not.toContain(csi);
    expect(text).not.toContain(del);
    expect(text).toContain('bad');
  });

  it('bounds each issue line', () => {
    const long = buildValidationEnvelope({
      attempt: 2,
      structural: [{ severity: 'error', code: 'empty_spec', message: 'y'.repeat(5000) }],
      semantic: [],
    });
    const lines = summarizeEnvelope(long, long).split('\n');
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(500);
  });
});
