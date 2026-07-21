import type { RunAgentInput } from '@ag-ui/client';
import { toAppEvent } from '../events/to-app-event.js';
import type { AppEvent } from '../events/app-event.js';
import { createSeqGuard } from '../sequencing/seq-guard.js';
import { createAbort } from './abort.js';
import type { AgentPort, RunHandle } from './agent-port.js';

/**
 * In-process AgentPort over an INJECTED generator. The generator yields minitui-native wire
 * events (plan-02 AgentEventSchema — RUN_STARTED/RUN_FINISHED already carry their own
 * threadId+runId, TOOL_CALL_START already carries toolCallName) STRAIGHT into the SAME
 * toAppEvent normalization + seq-guard the HttpAgent path uses — never raw to the AppEvent
 * stream, no HTTP/SSE. Slice 1 does NOT cross the AG-UI adapter boundary (ledger §L): the
 * explicit minitui→AG-UI adapter (`toAgUiEvent`, ./to-ag-ui.ts) is reserved for a genuinely-
 * remote BFF producing real AG-UI wire events and is never invoked here. Slice-1 default;
 * wired in cli/main.tsx so transport never imports agent-core.
 */
export function createLocalAgentPort<E extends { type: string }>(
  genFactory: (input: RunAgentInput, signal: AbortSignal) => AsyncGenerator<E>,
): AgentPort {
  return {
    run(input: RunAgentInput): RunHandle {
      const { controller, signal } = createAbort();
      const seq = createSeqGuard();

      async function* events(): AsyncGenerator<AppEvent> {
        const source = genFactory(input, signal);
        try {
          for await (const raw of source) {
            if (signal.aborted) break;
            const app = toAppEvent(raw);
            // seq-guard live path. Slice 1 enforces the missed-baseline invariant (a delta
            // before any snapshot is a desync). The out-of-order branch (strictly-increasing
            // seq) activates in Slice 2 once STATE_DELTA carries a seq on the wire — resync.ts.
            // ponytail: no seq arg here yet; missed-baseline is the only verdict the Slice-1
            // wire can produce, and it's the one that prevents silent store corruption.
            if (app.kind === 'state-snapshot') seq.onSnapshot();
            else if (app.kind === 'state-delta') {
              const verdict = seq.checkDelta();
              if (!verdict.ok) {
                yield { kind: 'run-error', message: `desync: ${verdict.reason}`, retriable: true };
                continue;
              }
            }
            yield app;
          }
        } finally {
          // Parity with the remote return() teardown (controller.abort(); finish()): a consumer
          // breaking out of for-await WITHOUT an explicit handle.abort() must still fire the run's
          // controller, so anything the injected genFactory keyed on `signal` is torn down.
          controller.abort();
          await source.return(undefined);
        }
      }

      return { events: events(), abort: () => controller.abort(), signal };
    },
  };
}
