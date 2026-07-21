import { describe, it, expect } from 'vitest';
import { Subject } from 'rxjs';
import { EventType, type BaseEvent } from '@ag-ui/core';
import type { HttpAgent, RunAgentInput } from '@ag-ui/client';
import { createAgUiAgentPort } from '../src/agent/ag-ui-agent.js';
import { buildRunAgentInput } from '../src/agent/run-input.js';

// minimal REAL fake: createAgUiAgentPort only calls run(), so a real object implementing
// Pick<HttpAgent, 'run'> stands in with no cast; run() returns an Observable<BaseEvent> we drive by hand.
function fakeAgent(subject: Subject<BaseEvent>): Pick<HttpAgent, 'run'> {
  return { run: () => subject.asObservable() };
}
const input: RunAgentInput = buildRunAgentInput({ threadId: 't', runId: 'r', userText: 'go' });

describe('createAgUiAgentPort (remote path, same toAppEvent chokepoint)', () => {
  it('normalizes the Observable into ordered AppEvents and completes the generator', async () => {
    const subject = new Subject<BaseEvent>();
    const handle = createAgUiAgentPort(fakeAgent(subject)).run(input);

    // push a scripted stream, then complete
    subject.next({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' } as BaseEvent);
    subject.next({ type: EventType.STATE_SNAPSHOT, snapshot: { p: 0 } } as BaseEvent);
    subject.next({ type: EventType.RUN_FINISHED, threadId: 't', runId: 'r' } as BaseEvent);
    subject.complete();

    const kinds: string[] = [];
    for await (const e of handle.events) kinds.push(e.kind);
    expect(kinds).toEqual(['run-started', 'state-snapshot', 'run-finished']);
  });

  it('surfaces an Observable error as a retriable run-error then ends', async () => {
    const subject = new Subject<BaseEvent>();
    const handle = createAgUiAgentPort(fakeAgent(subject)).run(input);
    subject.error(new Error('sse dropped'));

    const events = [];
    for await (const e of handle.events) events.push(e);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'run-error', retriable: true });
  });

  it('return()/abort tears down: the generator stops and the signal is aborted', async () => {
    const subject = new Subject<BaseEvent>();
    const handle = createAgUiAgentPort(fakeAgent(subject)).run(input);
    subject.next({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' } as BaseEvent);

    const it = handle.events[Symbol.asyncIterator]();
    expect((await it.next()).value).toMatchObject({ kind: 'run-started' });
    await it.return?.(undefined); // consumer breaks out of the loop
    expect(handle.signal.aborted).toBe(true);
    expect((await it.next()).done).toBe(true);
  });

  it('reassembles TEXT_MESSAGE_CHUNK into text-deltas (the pipeline stage a bare run() skips)', async () => {
    const subject = new Subject<BaseEvent>();
    const handle = createAgUiAgentPort(fakeAgent(subject)).run(input);
    subject.next({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' } as BaseEvent);
    subject.next({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'm1', delta: 'he' } as BaseEvent);
    subject.next({ type: EventType.TEXT_MESSAGE_CHUNK, delta: 'llo' } as BaseEvent); // continuation: no messageId
    subject.next({ type: EventType.RUN_FINISHED, threadId: 't', runId: 'r' } as BaseEvent);
    subject.complete();

    const events = [];
    for await (const e of handle.events) events.push(e);
    // transformChunks expanded the chunks into TEXT_MESSAGE_START/CONTENT/END; toAppEvent maps
    // the CONTENTs to text-deltas (START/END ride passthrough) — nothing is silently dropped.
    expect(events.filter((e) => e.kind === 'text-delta')).toEqual([
      { kind: 'text-delta', messageId: 'm1', delta: 'he' },
      { kind: 'text-delta', messageId: 'm1', delta: 'llo' },
    ]);
    expect(events[0]).toMatchObject({ kind: 'run-started' });
    expect(events[events.length - 1]).toMatchObject({ kind: 'run-finished' });
  });

  it('bounds the buffer: a fast producer with no consumer drops OLDEST past the ceiling (§Z30)', async () => {
    const subject = new Subject<BaseEvent>();
    const warnings: Array<[string, Record<string, unknown> | undefined]> = [];
    const diagnostics = {
      warn: (msg: string, meta?: Record<string, unknown>) => {
        warnings.push([msg, meta]);
      },
      debug() {},
    };
    // ceiling of 2, nothing consuming yet -> events buffer and the OLDEST drop past the ceiling
    // (bounded remote pump, §Z30 — not an unbounded AppEvent[]).
    const handle = createAgUiAgentPort(fakeAgent(subject), { maxQueue: 2, diagnostics }).run(input);
    subject.next({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' } as BaseEvent);
    subject.next({ type: EventType.STATE_SNAPSHOT, snapshot: { n: 1 } } as BaseEvent);
    subject.next({ type: EventType.STATE_SNAPSHOT, snapshot: { n: 2 } } as BaseEvent); // buffer full -> drop run-started
    subject.next({ type: EventType.STATE_SNAPSHOT, snapshot: { n: 3 } } as BaseEvent); // -> drop snapshot n:1
    subject.complete();

    const snapshots: number[] = [];
    for await (const e of handle.events)
      if (e.kind === 'state-snapshot') snapshots.push((e.snapshot as { n: number }).n);
    expect(snapshots).toEqual([2, 3]); // only the last 2 survived the ceiling; oldest dropped
    expect(warnings).toHaveLength(2); // two drops -> two diagnostics
    expect(warnings[0]?.[0]).toContain('dropped');
  });

  it('abort() settles a next() parked on an empty queue (no forever-hang) (bus-agent-01)', async () => {
    const subject = new Subject<BaseEvent>();
    const handle = createAgUiAgentPort(fakeAgent(subject)).run(input);
    const it = handle.events[Symbol.asyncIterator]();
    const parked = it.next(); // nothing queued yet -> parks in the waiters array
    handle.abort(); // before the fix: aborts the controller but never finish() -> parked hangs
    const res = await parked;
    expect(res.done).toBe(true);
  }, 2000);

  it('throw() tears the run down: aborts the signal and settles a parked next() (bus-agent-03)', async () => {
    const subject = new Subject<BaseEvent>();
    const handle = createAgUiAgentPort(fakeAgent(subject)).run(input);
    const it = handle.events[Symbol.asyncIterator]();
    const parked = it.next();
    await expect(it.throw?.(new Error('boom'))).rejects.toThrow('boom');
    expect(handle.signal.aborted).toBe(true); // throw() must fire the controller too
    expect((await parked).done).toBe(true); // and settle the parked read, not leave it hung
  }, 2000);
});
