import { transformChunks, verifyEvents, type HttpAgent, type RunAgentInput } from '@ag-ui/client';
import type { BaseEvent } from '@ag-ui/core';
import type { DiagnosticsPort } from '@minitui/types';
import { toAppEvent } from '../events/to-app-event.js';
import type { AppEvent } from '../events/app-event.js';
import { subscribeToObservable } from './subscribe.js';
import { createAbort } from './abort.js';
import type { AgentPort, RunHandle } from './agent-port.js';

/** §Z30: ceiling for the remote Observable->AsyncGenerator buffer — a fast remote producer plus a slow
 *  consumer must not grow the AppEvent[] backlog unboundedly. Mirrors the agent-core queue mark. */
const REMOTE_PUMP_HIGH_WATER_MARK = 1024;

/**
 * AgentPort over @ag-ui/client HttpAgent (POST + SSE). Reserved for a genuinely-remote BFF.
 * Restores the AbstractAgent.runAgent() pipeline stages a bare run() skips (ledger G12):
 * transformChunks reassembles TEXT_MESSAGE_CHUNK/TOOL_CALL_CHUNK into *_START/*_CONTENT/
 * *_ARGS/*_END, and verifyEvents enforces protocol order — a violation ERRORS the stream,
 * surfacing here as a retriable run-error. Then routes through the SAME toAppEvent
 * chokepoint as local-agent, so remote and in-process are indistinguishable downstream.
 */
export function createAgUiAgentPort(
  agent: Pick<HttpAgent, 'run'>,
  opts?: { maxQueue?: number; diagnostics?: DiagnosticsPort },
): AgentPort {
  const maxQueue = opts?.maxQueue ?? REMOTE_PUMP_HIGH_WATER_MARK;
  return {
    run(input: RunAgentInput): RunHandle {
      const { controller, signal } = createAbort();
      const queue: AppEvent[] = [];
      const waiters: Array<(v: IteratorResult<AppEvent, undefined>) => void> = [];
      let done = false;

      const emit = (e: AppEvent): void => {
        const w = waiters.shift();
        if (w) {
          w({ value: e, done: false });
          return;
        }
        // §Z30: BOUND the buffer — a fast remote producer + a slow consumer must not grow AppEvent[]
        // unboundedly. Drop OLDEST past the ceiling and surface it through diagnostics; on the remote
        // path a dropped STATE_DELTA forces full resync — no seq-guard runs on this pump in Slice 1
        // (only local-agent has one); Slice-2 must add seq metadata + a seq-guard here before this
        // path ships, so the drop stops being silent.
        if (queue.length >= maxQueue) {
          queue.shift();
          opts?.diagnostics?.warn('remote agent pump dropped oldest event (backpressure)', {
            maxQueue,
          });
        }
        queue.push(e);
      };
      const finish = (): void => {
        done = true;
        let w = waiters.shift();
        while (w) {
          w({ value: undefined, done: true });
          w = waiters.shift();
        }
      };

      // Without these two stages a chunked remote stream falls to passthrough downstream
      // and an out-of-protocol stream corrupts state silently instead of erroring.
      const obs = agent.run(input).pipe(transformChunks(), verifyEvents());
      subscribeToObservable<BaseEvent>(obs, (raw) => emit(toAppEvent(raw)), {
        signal,
        onError: (e) => {
          emit({
            kind: 'run-error',
            message: e instanceof Error ? e.message : String(e),
            retriable: true,
          });
          finish();
        },
        onComplete: finish,
      });

      const events: AsyncGenerator<AppEvent, undefined> = {
        next(): Promise<IteratorResult<AppEvent, undefined>> {
          if (queue.length)
            return Promise.resolve({ value: queue.shift() as AppEvent, done: false });
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
        return(): Promise<IteratorResult<AppEvent, undefined>> {
          controller.abort();
          finish();
          return Promise.resolve({ value: undefined, done: true });
        },
        throw(e: unknown): Promise<IteratorResult<AppEvent, undefined>> {
          return Promise.reject(e instanceof Error ? e : new Error(String(e)));
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };

      return { events, abort: () => controller.abort(), signal };
    },
  };
}
