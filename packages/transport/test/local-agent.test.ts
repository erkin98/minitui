import { describe, it, expect } from 'vitest';
import { createLocalAgentPort } from '../src/agent/local-agent.js';
import { buildRunAgentInput } from '../src/agent/run-input.js';
import type { RunAgentInput } from '@ag-ui/client';

// minitui wire events (plan-02 AgentEventSchema — the canonical wire vocabulary, source-verified
// against packages/types/src/events.ts): RUN_STARTED/RUN_FINISHED carry threadId+runId NATIVELY
// (required fields, not synthesized — ledger §N) and TOOL_CALL_START carries toolCallName, never
// toolName (the schema's negative test rejects toolName outright). The only field genuinely
// absent from minitui's wire is messageId (TEXT_MESSAGE_CONTENT is just { type, delta }) — Slice
// 1 does NOT synthesize it (ledger §L: local-agent.ts feeds this union straight through
// toAppEvent, never crossing the AG-UI adapter boundary). Zero casts in the fixtures.
async function* scripted() {
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
    async function* forever(_i: RunAgentInput, signal: AbortSignal) {
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
    async function* forever(_i: RunAgentInput, signal: AbortSignal) {
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
    async function* noBaseline() {
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

  it('buildRunAgentInput carries only userText as the untrusted field', () => {
    const input = buildRunAgentInput({ threadId: 't', runId: 'r', userText: 'hi' });
    expect(input.threadId).toBe('t');
    expect(input.runId).toBe('r');
    const lastMsg = input.messages.at(-1);
    expect(lastMsg).toMatchObject({ role: 'user', content: 'hi' });
  });
});
