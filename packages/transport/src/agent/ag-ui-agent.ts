import { transformChunks, verifyEvents, type HttpAgent, type RunAgentInput } from '@ag-ui/client';
import type { BaseEvent } from '@ag-ui/core';
import type { DiagnosticsPort } from '@minitui/types';
import { toAppEvent } from '../events/to-app-event.js';
import type { AppEvent } from '../events/app-event.js';
import { subscribeToObservable } from './subscribe.js';
import { createAbort } from './abort.js';
import { formatUnknown } from '../format-unknown.js';
import type { AgentPort, RunHandle } from './agent-port.js';

/** Ceiling for the remote Observable-to-AsyncGenerator buffer. */
const REMOTE_PUMP_HIGH_WATER_MARK = 1024;

/**
 * AgentPort over @ag-ui/client HttpAgent (POST + SSE). Reserved for a genuinely-remote BFF.
 * Restores the AbstractAgent.runAgent() pipeline stages a bare run() skips:
 * transformChunks reassembles TEXT_MESSAGE_CHUNK/TOOL_CALL_CHUNK into *_START/*_CONTENT/
 * *_ARGS/*_END, and verifyEvents enforces protocol order — a violation ERRORS the stream,
 * surfacing here as a retriable run-error. Then routes through the SAME toAppEvent
 * chokepoint as local-agent — but toAppEvent normalizes minitui's own wire vocabulary, not
 * @ag-ui/core's. A genuinely remote AG-UI server's events need an inbound adapter (the
 * mirror of the outbound toAgUiEvent) translating them onto that vocabulary before this
 * port is schema-compatible with third-party producers.
 */
export function createAgUiAgentPort(
  agent: Pick<HttpAgent, 'run'>,
  opts?: { maxQueue?: number; diagnostics?: DiagnosticsPort },
): AgentPort {
  const maxQueue = opts?.maxQueue ?? REMOTE_PUMP_HIGH_WATER_MARK;
  if (!Number.isFinite(maxQueue) || maxQueue <= 0) {
    throw new Error(`maxQueue must be a finite positive number, got ${maxQueue}`);
  }
  return {
    run(input: RunAgentInput): RunHandle {
      const { controller, signal } = createAbort();
      const queue: AppEvent[] = [];
      const waiters: Array<(v: IteratorResult<AppEvent, undefined>) => void> = [];
      let done = false;

      const emit = (event: AppEvent): void => {
        const waiter = waiters.shift();
        if (waiter) {
          waiter({ value: event, done: false });
          return;
        }
        // Bound the buffer so a fast producer and slow consumer cannot grow AppEvent[]
        // unboundedly. Drop OLDEST past the ceiling and surface it through diagnostics; on the remote
        // path a dropped STATE_DELTA forces full resync — no seq-guard runs on this pump in Slice 1
        // (only local-agent has one); Slice-2 must add seq metadata + a seq-guard here before this
        // path ships, so the drop stops being silent.
        if (queue.length >= maxQueue) {
          queue.shift();
          try {
            opts?.diagnostics?.warn('remote agent pump dropped oldest event (backpressure)', {
              maxQueue,
            });
          } catch {
            // Diagnostics is observational and cannot break delivery. Unguarded, a throwing sink
            // here loses BOTH events — the evicted one is already gone and the push below never
            // runs — and escapes emit() into the rxjs subscriber callback.
          }
        }
        queue.push(event);
      };
      const finish = (): void => {
        done = true;
        let waiter = waiters.shift();
        while (waiter) {
          waiter({ value: undefined, done: true });
          waiter = waiters.shift();
        }
      };
      // One idempotent teardown for every consumer-initiated close (handle.abort / return / throw):
      // fire the run controller (its signal unsubscribes the rxjs source) AND finish() so a next()
      // parked on the empty queue settles with { done: true } instead of hanging forever.
      const close = (): void => {
        controller.abort();
        finish();
      };

      const fail = (error: unknown): void => {
        emit({
          kind: 'run-error',
          message: formatUnknown(error),
          retriable: true,
        });
        finish();
      };

      // Without these two stages a chunked remote stream falls to passthrough downstream
      // and an out-of-protocol stream corrupts state silently instead of erroring.
      // Contained: a producer that fails synchronously must reach the consumer through this
      // handle — the way local-agent's deferred construction does — and never escape run()
      // itself, which is not async and would otherwise hand the caller a throw instead of a port.
      try {
        const obs = agent.run(input).pipe(transformChunks(), verifyEvents());
        subscribeToObservable<BaseEvent>(obs, (raw) => emit(toAppEvent(raw)), {
          signal,
          onError: fail,
          onComplete: finish,
        });
      } catch (error) {
        fail(error);
      }

      const events: AsyncGenerator<AppEvent, undefined> = {
        next(): Promise<IteratorResult<AppEvent, undefined>> {
          if (queue.length)
            return Promise.resolve({ value: queue.shift() as AppEvent, done: false });
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
        return(): Promise<IteratorResult<AppEvent, undefined>> {
          close();
          return Promise.resolve({ value: undefined, done: true });
        },
        throw(reason: unknown): Promise<IteratorResult<AppEvent, undefined>> {
          close();
          // Reject with the consumer's value verbatim: coercing to Error would run
          // String(reason), which can itself throw, and would break identity with
          // local-agent's throw(), which rejects with the same value unchanged.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject(reason);
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };

      return { events, abort: () => close(), signal };
    },
  };
}
