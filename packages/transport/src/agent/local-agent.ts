import type { RunAgentInput } from '@ag-ui/client';
import type { AgentEvent } from '@minitui/types';
import { toAppEvent } from '../events/to-app-event.js';
import type { AppEvent } from '../events/app-event.js';
import { createSeqGuard } from '../sequencing/seq-guard.js';
import { createAbort } from './abort.js';
import type { AgentPort, RunHandle } from './agent-port.js';

// `error.name` is attacker-reachable: the rejected value can be any object, including one
// whose `name` is a throwing getter or a Proxy trap. This runs on the cancellation path,
// where an escaping throw would turn a clean abort into a leaked failure — so the read is
// contained rather than trusted. Not defensive bloat; the containment is the point.
function isAbortError(error: unknown): boolean {
  try {
    return (
      typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
    );
  } catch {
    return false;
  }
}

function done(): IteratorReturnResult<undefined> {
  return { value: undefined, done: true };
}

/**
 * In-process AgentPort over an INJECTED generator. The generator yields minitui-native wire
 * events (AgentEventSchema — RUN_STARTED/RUN_FINISHED already carry their own
 * threadId+runId, TOOL_CALL_START already carries toolCallName) STRAIGHT into the SAME
 * toAppEvent normalization + seq-guard the HttpAgent path uses — never raw to the AppEvent
 * stream, no HTTP/SSE. The in-process path does not cross the AG-UI adapter boundary: the
 * explicit minitui→AG-UI adapter (`toAgUiEvent`, ./to-ag-ui.ts) is reserved for a genuinely-
 * remote BFF producing real AG-UI wire events and is never invoked here. The in-process default;
 * wired in cli/main.tsx so transport never imports agent-core.
 */
export function createLocalAgentPort(
  genFactory: (input: RunAgentInput, signal: AbortSignal) => AsyncGenerator<AgentEvent>,
): AgentPort {
  return {
    run(input: RunAgentInput): RunHandle {
      const { controller, signal } = createAbort();
      const seq = createSeqGuard();
      let source: AsyncGenerator<AgentEvent> | undefined;
      let closed = false;
      let closePromise: Promise<void> | undefined;

      const normalizeEvent = (event: AgentEvent): AppEvent => {
        const app = toAppEvent(event);
        // This path enforces the missed-baseline invariant; strict wire sequencing activates once
        // STATE_DELTA carries a sequence number in a later resync stage.
        if (app.kind === 'state-snapshot') seq.onSnapshot();
        else if (app.kind === 'state-delta') {
          const verdict = seq.checkDelta();
          if (!verdict.ok) {
            return {
              kind: 'run-error',
              message: `desync: ${verdict.reason}`,
              retriable: true,
            };
          }
        }
        return app;
      };

      const close = (): Promise<void> => {
        if (closePromise) return closePromise;

        closed = true;
        const currentSource = source;
        closePromise = Promise.resolve()
          .then(async () => {
            await currentSource?.return(undefined);
          })
          .then(() => undefined);
        controller.abort();
        return closePromise;
      };

      const readNext = async (): Promise<IteratorResult<AppEvent, undefined>> => {
        if (closed || signal.aborted) {
          await close();
          return done();
        }

        try {
          source ??= genFactory(input, signal);
          const next = await source.next();
          if (next.done) {
            await close();
            return done();
          }
          if (closed || signal.aborted) {
            await close();
            return done();
          }

          return { value: normalizeEvent(next.value), done: false };
        } catch (error) {
          const wasCancelled = signal.aborted && isAbortError(error);
          try {
            await close();
          } catch (cleanupError) {
            if (wasCancelled && !isAbortError(cleanupError)) throw cleanupError;
          }
          if (wasCancelled) return done();
          throw error;
        }
      };

      // next() calls are serialized: each read chains onto the previous one's settlement,
      // and onto BOTH arms so one rejection does not poison the chain. Concurrent next()
      // calls would otherwise pull the injected source in parallel — which a real
      // AsyncGenerator rejects outright — and race the closed/aborted checks that straddle
      // the await inside readNext.
      let readTail = Promise.resolve();
      const events: AsyncGenerator<AppEvent> = {
        next() {
          const result = readTail.then(readNext, readNext);
          readTail = result.then(
            () => undefined,
            () => undefined,
          );
          return result;
        },
        async return() {
          await close();
          return done();
        },
        async throw(error?: unknown) {
          try {
            await close();
          } catch {
            // Preserve the consumer-supplied failure.
          }
          throw error;
        },
        [Symbol.asyncIterator]() {
          return events;
        },
      };

      return {
        events,
        abort: () => {
          void close().catch(() => undefined);
        },
        signal,
      };
    },
  };
}
