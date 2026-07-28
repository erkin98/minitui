import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '@minitui/types';
import { createLocalAgentPort } from '../src/agent/local-agent.js';
import { buildRunAgentInput } from '../src/agent/run-input.js';
import type { RunAgentInput } from '@ag-ui/client';

// The factory must reject a generator that yields a structurally incomplete wire event.
// Assert<false> fails to compile if RUN_STARTED without its IDs becomes assignable.
type Assert<T extends true> = T;
type _RejectsIncompleteWireEvent = Assert<
  (() => AsyncGenerator<{ type: 'RUN_STARTED' }>) extends Parameters<typeof createLocalAgentPort>[0]
    ? false
    : true
>;

// minitui wire events (AgentEventSchema — the canonical wire vocabulary, source-verified
// against packages/types/src/events.ts): RUN_STARTED/RUN_FINISHED carry threadId+runId NATIVELY
// (required fields, not synthesized) and TOOL_CALL_START carries toolCallName, never
// toolName (the schema's negative test rejects toolName outright). The only field genuinely
// absent from minitui's wire is messageId (TEXT_MESSAGE_CONTENT is just { type, delta }) — Slice
// 1 does not synthesize it: local-agent.ts feeds this union straight through
// toAppEvent, never crossing the AG-UI adapter boundary). Zero casts in the fixtures.
async function* scripted(): AsyncGenerator<AgentEvent> {
  yield { type: 'RUN_STARTED', threadId: 't', runId: 'r' };
  yield { type: 'STATE_SNAPSHOT', snapshot: { p: 0 } };
  yield { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/p', value: 50 }] };
  yield { type: 'RUN_FINISHED', threadId: 't', runId: 'r' };
}

describe('createLocalAgentPort', () => {
  it('feeds injected minitui wire events straight into toAppEvent without an AG-UI adapter', async () => {
    const port = createLocalAgentPort(() => scripted());
    const input = buildRunAgentInput({ threadId: 't', runId: 'r', userText: 'merge' });
    const handle = port.run(input);
    const events = [];
    for await (const e of handle.events) events.push(e);
    expect(events.map((e) => e.kind)).toEqual([
      'run-started',
      'state-snapshot',
      'state-delta',
      'run-finished',
    ]);
    // threadId/runId come straight off the wire event itself — the port stamps nothing
    expect(events[0]).toEqual({ kind: 'run-started', threadId: 't', runId: 'r' });
  });

  it('abort() stops the stream (messageId is empty — Slice 1 never synthesizes AG-UI fields)', async () => {
    async function* forever(_i: RunAgentInput, signal: AbortSignal): AsyncGenerator<AgentEvent> {
      let i = 0;
      while (!signal.aborted) {
        yield { type: 'TEXT_MESSAGE_CONTENT', delta: String(i++) }; // minitui wire: no messageId, ever
      }
    }
    const port = createLocalAgentPort(forever);
    const handle = port.run(buildRunAgentInput({ threadId: 't', runId: 'r', userText: 'x' }));
    const out = [];
    for await (const e of handle.events) {
      out.push(e);
      if (out.length === 3) handle.abort();
    }
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ kind: 'text-delta', messageId: '', delta: '0' });
    expect(handle.signal.aborted).toBe(true);
  });

  it('breaking out of the stream without an explicit abort still aborts the signal (finally parity)', async () => {
    // A consumer that stops iterating WITHOUT calling handle.abort() must still tear down: the
    // generator's finally fires controller.abort(), matching the remote ag-ui return(). Positive
    // control that anything the genFactory keyed on `signal` is cleaned up on break-out.
    async function* forever(_i: RunAgentInput, signal: AbortSignal): AsyncGenerator<AgentEvent> {
      let i = 0;
      while (!signal.aborted) yield { type: 'TEXT_MESSAGE_CONTENT', delta: String(i++) };
    }
    const port = createLocalAgentPort(forever);
    const handle = port.run(buildRunAgentInput({ threadId: 't', runId: 'r', userText: 'x' }));
    const it = handle.events[Symbol.asyncIterator]();
    await it.next();
    await it.return?.(undefined); // consumer breaks out — no handle.abort()
    expect(handle.signal.aborted).toBe(true);
  });

  it('emits a desync run-error when a STATE_DELTA arrives before any STATE_SNAPSHOT', async () => {
    // seq-guard live path: a delta with no baseline must surface as a recoverable run-error,
    // not silently corrupt the store. Proves seq.checkDelta() is wired (not dead code).
    async function* noBaseline(): AsyncGenerator<AgentEvent> {
      yield { type: 'RUN_STARTED', threadId: 't', runId: 'r' };
      yield { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/p', value: 1 }] };
    }
    const port = createLocalAgentPort(() => noBaseline());
    const handle = port.run(buildRunAgentInput({ threadId: 't', runId: 'r', userText: 'x' }));
    const events = [];
    for await (const e of handle.events) events.push(e);
    // the raw STATE_DELTA is replaced by a desync run-error; the bad delta never reaches the store
    expect(events.map((e) => e.kind)).toEqual(['run-started', 'run-error']);
    const err = events[1] as Extract<(typeof events)[number], { kind: 'run-error' }>;
    expect(err.message).toBe('desync: missed-baseline');
    expect(err.retriable).toBe(true);
  });

  it('aborts the run signal when the injected genFactory throws synchronously', async () => {
    // A genFactory that validates synchronously and throws BEFORE returning its generator must
    // still tear the run down — the finally's controller.abort() has to fire, not be skipped
    // because the factory call sat outside the try.
    const port = createLocalAgentPort(() => {
      throw new Error('sync boom');
    });
    const handle = port.run(buildRunAgentInput({ threadId: 't', runId: 'r', userText: 'x' }));
    await expect(handle.events.next()).rejects.toThrow('sync boom');
    expect(handle.signal.aborted).toBe(true);
  });

  it('closes the injected source exactly once when the consumer breaks (no double cleanup)', async () => {
    // A consumer breaking out (outer return()) must call the injected source's return() ONCE.
    // A for-await over `source` triggers BOTH language IteratorClose AND the finally's own
    // return() — a double release for a source that closes a handle/lock on cleanup. Driven
    // through a REAL AsyncGenerator port implementation (no vi.* double), a counting return().
    let returnCalls = 0;
    const makeSource = (): AsyncGenerator<AgentEvent> => {
      let i = 0;
      const source: AsyncGenerator<AgentEvent> = {
        next() {
          return Promise.resolve({
            value: { type: 'TEXT_MESSAGE_CONTENT', delta: String(i++) },
            done: false,
          });
        },
        return() {
          returnCalls++;
          return Promise.resolve({ value: undefined, done: true });
        },
        throw(e?: unknown) {
          return Promise.reject(e instanceof Error ? e : new Error(String(e)));
        },
        [Symbol.asyncIterator]() {
          return source;
        },
      };
      return source;
    };
    const port = createLocalAgentPort(makeSource);
    const handle = port.run(buildRunAgentInput({ threadId: 't', runId: 'r', userText: 'x' }));
    const it = handle.events[Symbol.asyncIterator]();
    await it.next(); // suspend inside the loop, past one yield
    await it.return?.(undefined); // consumer breaks out
    expect(returnCalls).toBe(1); // exactly once — not twice
  });

  it('does not create or pull the source when abort happens before the first read', async () => {
    let factoryCalls = 0;
    let nextCalls = 0;
    const port = createLocalAgentPort(() => {
      factoryCalls++;
      const source: AsyncGenerator<AgentEvent> = {
        next() {
          nextCalls++;
          return Promise.resolve({
            value: { type: 'TEXT_MESSAGE_CONTENT', delta: 'late' },
            done: false,
          });
        },
        return() {
          return Promise.resolve({ value: undefined, done: true });
        },
        throw(error?: unknown) {
          return Promise.reject(error);
        },
        [Symbol.asyncIterator]() {
          return source;
        },
      };
      return source;
    });
    const handle = port.run(buildRunAgentInput({ threadId: 't', runId: 'r', userText: 'x' }));

    handle.abort();

    await expect(handle.events.next()).resolves.toEqual({ value: undefined, done: true });
    expect(factoryCalls).toBe(0);
    expect(nextCalls).toBe(0);
  });

  it('turns an abort-induced pending-pull AbortError into clean completion', async () => {
    let returnCalls = 0;
    const port = createLocalAgentPort((_input, signal) => {
      const source: AsyncGenerator<AgentEvent> = {
        next() {
          return new Promise((_resolve, reject) => {
            const rejectAbort = () => reject(new DOMException('run cancelled', 'AbortError'));
            if (signal.aborted) rejectAbort();
            else signal.addEventListener('abort', rejectAbort, { once: true });
          });
        },
        return() {
          returnCalls++;
          return Promise.resolve({ value: undefined, done: true });
        },
        throw(error?: unknown) {
          return Promise.reject(error);
        },
        [Symbol.asyncIterator]() {
          return source;
        },
      };
      return source;
    });
    const handle = port.run(buildRunAgentInput({ threadId: 't', runId: 'r', userText: 'x' }));
    const pending = handle.events.next();
    await Promise.resolve();

    handle.abort();

    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    expect(returnCalls).toBe(1);
  });

  it('closes an idle source immediately and exactly once when abort is repeated', async () => {
    let returnCalls = 0;
    const port = createLocalAgentPort(() => {
      const source: AsyncGenerator<AgentEvent> = {
        next() {
          return Promise.resolve({
            value: { type: 'TEXT_MESSAGE_CONTENT', delta: 'one' },
            done: false,
          });
        },
        return() {
          returnCalls++;
          return Promise.resolve({ value: undefined, done: true });
        },
        throw(error?: unknown) {
          return Promise.reject(error);
        },
        [Symbol.asyncIterator]() {
          return source;
        },
      };
      return source;
    });
    const handle = port.run(buildRunAgentInput({ threadId: 't', runId: 'r', userText: 'x' }));
    await handle.events.next();

    handle.abort();
    handle.abort();
    await Promise.resolve();

    expect(returnCalls).toBe(1);
    await expect(handle.events.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('propagates a producer failure that is unrelated to cancellation', async () => {
    const producerError = new Error('producer failed');
    const port = createLocalAgentPort(() => {
      const source: AsyncGenerator<AgentEvent> = {
        next() {
          return Promise.reject(producerError);
        },
        return() {
          return Promise.resolve({ value: undefined, done: true });
        },
        throw(error?: unknown) {
          return Promise.reject(error);
        },
        [Symbol.asyncIterator]() {
          return source;
        },
      };
      return source;
    });
    const handle = port.run(buildRunAgentInput({ threadId: 't', runId: 'r', userText: 'x' }));

    await expect(handle.events.next()).rejects.toBe(producerError);
    expect(handle.signal.aborted).toBe(true);
  });

  it('keeps concurrent run cancellation and cleanup independent', async () => {
    const returnCalls = new Map<number, number>();
    const counts = () => [returnCalls.get(0) ?? 0, returnCalls.get(1) ?? 0];
    let sourceIndex = 0;
    const port = createLocalAgentPort(() => {
      const index = sourceIndex++;
      let value = 0;
      const source: AsyncGenerator<AgentEvent> = {
        next() {
          return Promise.resolve({
            value: { type: 'TEXT_MESSAGE_CONTENT', delta: `${index}:${value++}` },
            done: false,
          });
        },
        return() {
          returnCalls.set(index, (returnCalls.get(index) ?? 0) + 1);
          return Promise.resolve({ value: undefined, done: true });
        },
        throw(error?: unknown) {
          return Promise.reject(error);
        },
        [Symbol.asyncIterator]() {
          return source;
        },
      };
      return source;
    });
    const input = buildRunAgentInput({ threadId: 't', runId: 'r', userText: 'x' });
    const first = port.run(input);
    const second = port.run(input);
    await first.events.next();
    await second.events.next();

    first.abort();
    await Promise.resolve();

    expect(counts()).toEqual([1, 0]);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    await expect(second.events.next()).resolves.toMatchObject({
      done: false,
      value: { kind: 'text-delta', delta: '1:1' },
    });
    await second.events.return(undefined);
    expect(counts()).toEqual([1, 1]);
  });

  it('uses the same exactly-once close transition for iterator throw()', async () => {
    let returnCalls = 0;
    const port = createLocalAgentPort(() => {
      const source: AsyncGenerator<AgentEvent> = {
        next() {
          return Promise.resolve({
            value: { type: 'TEXT_MESSAGE_CONTENT', delta: 'one' },
            done: false,
          });
        },
        return() {
          returnCalls++;
          return Promise.resolve({ value: undefined, done: true });
        },
        throw(error?: unknown) {
          return Promise.reject(error);
        },
        [Symbol.asyncIterator]() {
          return source;
        },
      };
      return source;
    });
    const handle = port.run(buildRunAgentInput({ threadId: 't', runId: 'r', userText: 'x' }));
    await handle.events.next();
    const consumerError = new Error('consumer stopped');

    await expect(handle.events.throw(consumerError)).rejects.toBe(consumerError);

    expect(handle.signal.aborted).toBe(true);
    expect(returnCalls).toBe(1);
  });

  it('buildRunAgentInput carries only userText as the untrusted field', () => {
    const input = buildRunAgentInput({ threadId: 't', runId: 'r', userText: 'hi' });
    expect(input.threadId).toBe('t');
    expect(input.runId).toBe('r');
    const lastMsg = input.messages.at(-1);
    expect(lastMsg).toMatchObject({ role: 'user', content: 'hi' });
  });
});
