import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '@minitui/types';
import { createLocalAgentPort } from '../src/agent/local-agent.js';
import { buildRunAgentInput } from '../src/agent/run-input.js';
import type { RunAgentInput } from '@ag-ui/client';

// Type-level positive control (C20): the genFactory bound must REJECT a generator that yields a
// structurally-incomplete wire event (a RUN_STARTED missing threadId/runId). The old
// `E extends { type: string }` bound wrongly accepted it. `Assert<false>` fails to compile, so
// this alias only type-checks once the parameter is tightened to AsyncGenerator<AgentEvent>.
type Assert<T extends true> = T;
type _c20RejectsIncompleteWireEvent = Assert<
  (() => AsyncGenerator<{ type: 'RUN_STARTED' }>) extends Parameters<typeof createLocalAgentPort>[0]
    ? false
    : true
>;

// minitui wire events (plan-02 AgentEventSchema — the canonical wire vocabulary, source-verified
// against packages/types/src/events.ts): RUN_STARTED/RUN_FINISHED carry threadId+runId NATIVELY
// (required fields, not synthesized — ledger §N) and TOOL_CALL_START carries toolCallName, never
// toolName (the schema's negative test rejects toolName outright). The only field genuinely
// absent from minitui's wire is messageId (TEXT_MESSAGE_CONTENT is just { type, delta }) — Slice
// 1 does NOT synthesize it (ledger §L: local-agent.ts feeds this union straight through
// toAppEvent, never crossing the AG-UI adapter boundary). Zero casts in the fixtures.
async function* scripted(): AsyncGenerator<AgentEvent> {
  yield { type: 'RUN_STARTED', threadId: 't', runId: 'r' };
  yield { type: 'STATE_SNAPSHOT', snapshot: { p: 0 } };
  yield { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/p', value: 50 }] };
  yield { type: 'RUN_FINISHED', threadId: 't', runId: 'r' };
}

describe('createLocalAgentPort', () => {
  it('feeds injected minitui wire events straight into toAppEvent — no AG-UI adapter crossing (ledger §L)', async () => {
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

  it('aborts the run signal when the injected genFactory throws synchronously (C20)', async () => {
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

  it('buildRunAgentInput carries only userText as the untrusted field', () => {
    const input = buildRunAgentInput({ threadId: 't', runId: 'r', userText: 'hi' });
    expect(input.threadId).toBe('t');
    expect(input.runId).toBe('r');
    const lastMsg = input.messages.at(-1);
    expect(lastMsg).toMatchObject({ role: 'user', content: 'hi' });
  });
});
