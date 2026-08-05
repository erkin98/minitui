import { describe, it, expect } from 'vitest';
import { Subject } from 'rxjs';
import { EventType, type BaseEvent } from '@ag-ui/core';
import type { HttpAgent, RunAgentInput } from '@ag-ui/client';
import { createAgUiAgentPort } from '../src/agent/ag-ui-agent.js';
import { createLocalAgentPort } from '../src/agent/local-agent.js';
import type { AgentPort } from '../src/agent/agent-port.js';
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

  it('drops the oldest buffered event past the remote queue ceiling', async () => {
    const subject = new Subject<BaseEvent>();
    const warnings: Array<[string, Record<string, unknown> | undefined]> = [];
    const diagnostics = {
      warn: (msg: string, meta?: Record<string, unknown>) => {
        warnings.push([msg, meta]);
      },
      debug() {},
    };
    // ceiling of 2, nothing consuming yet -> events buffer and the OLDEST drop past the ceiling
    // The remote pump is bounded rather than retaining an unbounded AppEvent array.
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

  it('a throwing diagnostics sink cannot break the remote pump', async () => {
    // The bare warn() sat BETWEEN the shift() that evicts an event and the push() that stores
    // the incoming one, so a throwing sink lost both and escaped emit() into the rxjs next
    // callback. Diagnostics is observational by contract: it cannot break the path it observes.
    // Same scenario as the ceiling test above, differing only in that this sink throws.
    const subject = new Subject<BaseEvent>();
    const diagnostics = {
      warn: (): void => {
        throw new Error('diagnostics sink boom');
      },
      debug() {},
    };
    const handle = createAgUiAgentPort(fakeAgent(subject), { maxQueue: 2, diagnostics }).run(input);
    subject.next({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' } as BaseEvent);
    subject.next({ type: EventType.STATE_SNAPSHOT, snapshot: { n: 1 } } as BaseEvent);
    subject.next({ type: EventType.STATE_SNAPSHOT, snapshot: { n: 2 } } as BaseEvent);
    subject.next({ type: EventType.STATE_SNAPSHOT, snapshot: { n: 3 } } as BaseEvent);
    subject.complete();

    const snapshots: number[] = [];
    for await (const e of handle.events)
      if (e.kind === 'state-snapshot') snapshots.push((e.snapshot as { n: number }).n);
    expect(snapshots).toEqual([2, 3]); // byte-identical to the non-throwing sink's result
  });

  it('neither AgentPort implementation throws synchronously out of run()', async () => {
    // Port-swap seam. local-agent defers its generator construction into the async, try-wrapped
    // readNext(), so a producer that fails synchronously still reaches the consumer through the
    // handle. The remote port built `agent.run(input).pipe(...)` inline in a non-async run(), so
    // the same failure escaped the port itself and no handle ever existed to observe it.
    const boom = new Error('producer exploded');
    const remote: AgentPort = createAgUiAgentPort({
      run: () => {
        throw boom;
      },
    });
    const local: AgentPort = createLocalAgentPort(() => {
      throw boom;
    });

    for (const port of [remote, local]) expect(() => port.run(input)).not.toThrow();

    // ...and each surfaces the failure through its own handle rather than losing it.
    const remoteEvents = [];
    for await (const e of remote.run(input).events) remoteEvents.push(e);
    expect(remoteEvents).toMatchObject([{ kind: 'run-error', retriable: true }]);
    await expect(local.run(input).events.next()).rejects.toBe(boom);
  });

  it('abort() settles a next() parked on an empty queue', async () => {
    const subject = new Subject<BaseEvent>();
    const handle = createAgUiAgentPort(fakeAgent(subject)).run(input);
    const it = handle.events[Symbol.asyncIterator]();
    const parked = it.next(); // nothing queued yet -> parks in the waiters array
    handle.abort();
    const res = await parked;
    expect(res.done).toBe(true);
  }, 2000);

  it('throw() tears the run down, aborts the signal, and settles a parked next()', async () => {
    const subject = new Subject<BaseEvent>();
    const handle = createAgUiAgentPort(fakeAgent(subject)).run(input);
    const it = handle.events[Symbol.asyncIterator]();
    const parked = it.next();
    await expect(it.throw?.(new Error('boom'))).rejects.toThrow('boom');
    expect(handle.signal.aborted).toBe(true); // throw() must fire the controller too
    expect((await parked).done).toBe(true); // and settle the parked read, not leave it hung
  }, 2000);

  it('throw() rejects with the exact value passed, even when it is not an Error', async () => {
    const subject = new Subject<BaseEvent>();
    const handle = createAgUiAgentPort(fakeAgent(subject)).run(input);
    const it = handle.events[Symbol.asyncIterator]();
    const parked = it.next();
    const consumerValue = { code: 'boom' }; // not an Error — must round-trip verbatim, no coercion
    await expect(it.throw?.(consumerValue)).rejects.toBe(consumerValue);
    expect(handle.signal.aborted).toBe(true);
    expect((await parked).done).toBe(true);
  }, 2000);

  it('rejects a non-finite or non-positive maxQueue at construction', () => {
    const agent = fakeAgent(new Subject<BaseEvent>());
    expect(() => createAgUiAgentPort(agent, { maxQueue: 0 })).toThrow();
    expect(() => createAgUiAgentPort(agent, { maxQueue: -1 })).toThrow();
    expect(() => createAgUiAgentPort(agent, { maxQueue: NaN })).toThrow();
    expect(() => createAgUiAgentPort(agent, { maxQueue: Infinity })).toThrow();
  });
});
