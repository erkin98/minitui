import type {
  ActionDispatcher,
  ActionLifecycleEvent,
  ActionOutcome,
  DispatchContext,
} from '@minitui/renderer-core';
import type { MinituiActionDef } from '@minitui/catalog';
import type { DiagnosticsPort, ExecEvent, JsonValue, RuntimeFault } from '@minitui/types';
import { boundText, errorText } from './bound-text.js';
import { reportFault } from './report.js';

export interface GatedHandlerArgs {
  readonly actionName: string;
  readonly def: MinituiActionDef;
  readonly dispatcher: ActionDispatcher;
  readonly getStateSnapshot: () => JsonValue;
  readonly emitLifecycle: (e: ActionLifecycleEvent) => void;
  // where a contained failure is reported; absent means nowhere
  readonly diagnostics?: DiagnosticsPort | undefined;
}

// fixed phrase of the report for a failure after the action started
const HANDLER_FAILED = 'gated action failed after it started';

// outcome.status -> the canonical-union lifecycle event the renderer surfaces.
// Per-variant payloads: result -> `result`, awaiting -> `awaiting` (returned by no shipped dispatcher,
// kept for one that returns before the answer), denied/failed -> `fault: RuntimeFault`.
function outcomeToEvent(
  actionName: string,
  elementKey: string,
  outcome: ActionOutcome,
): ActionLifecycleEvent {
  switch (outcome.status) {
    case 'settled':
      return { phase: 'result', actionName, elementKey, result: outcome.result };
    case 'awaiting':
      // No shipped dispatcher returns awaiting: its permission check blocks until the user answers. A
      // dispatcher that returns before the answer maps to this phase, with the requestId.
      return { phase: 'awaiting', actionName, elementKey, requestId: outcome.requestId };
    case 'denied': {
      // deny carries only a reason; surface it as a RuntimeFault so the lifecycle stays one shape.
      const fault: RuntimeFault = {
        actionKey: actionName,
        exitCode: -1,
        stderrExcerpt: boundText(outcome.reason),
      };
      return { phase: 'error', actionName, elementKey, fault };
    }
    case 'failed':
      return { phase: 'error', actionName, elementKey, fault: outcome.fault };
  }
}

export function gatedHandler(args: GatedHandlerArgs) {
  const { actionName, def, dispatcher, getStateSnapshot, emitLifecycle } = args;
  return async function handle(params: Record<string, unknown>, elementKey: string): Promise<void> {
    // Parse-before-execute: the catalog DECLARES def.params (zod); this handler is the
    // enforcement site. Malformed on-catalog action params fail closed here — a structured error
    // event, dispatcher NEVER called — before permission construction or execution.
    const parsed = def.params.safeParse(params);
    if (!parsed.success) {
      const fault: RuntimeFault = {
        actionKey: actionName,
        exitCode: -1,
        stderrExcerpt: boundText(`invalid params: ${parsed.error.message}`),
      };
      emitLifecycle({ phase: 'error', actionName, elementKey, fault });
      return;
    }
    emitLifecycle({ phase: 'started', actionName, elementKey });
    // After the run has ended, in either way, nothing more is emitted for it: late progress is dropped.
    let ended = false;
    const end = (event: ActionLifecycleEvent): void => {
      if (ended) return;
      ended = true;
      emitLifecycle(event);
    };
    try {
      // params arrive RESOLVED from json-render emit() — never re-resolve.
      const ctx: DispatchContext = {
        actionName,
        actionKind: def.kind,
        permission: def.permission,
        resolvedParams: parsed.data as Record<string, unknown>,
        stateSnapshot: getStateSnapshot(),
        elementKey,
        // The exec-progress correlation seam. The composition-root dispatcher streams exec
        // `ExecEvent`s through this callback; here we map a `progress` event to a FIRST-CLASS
        // lifecycle `progress` phase so the renderer chrome updates live. (That dispatcher ALSO
        // maps the same event to a store delta so a bound Progress widget moves — the two
        // consumers are independent; this package owns the lifecycle mapping, the composition
        // root owns the store delta.)
        onEvent: (ev: ExecEvent) => {
          if (ev.kind === 'progress' && !ended) {
            emitLifecycle({
              phase: 'progress',
              actionName,
              elementKey,
              progress: ev.value,
              ...(ev.message !== undefined ? { message: boundText(ev.message) } : {}),
            });
          }
        },
      };
      const outcome = await dispatcher.dispatch(actionName, ctx);
      end(outcomeToEvent(actionName, elementKey, outcome));
    } catch (error) {
      // A throw or rejection after `started` still ends the run with exactly one terminal event, and
      // never reaches the library's console output.
      reportFault(args.diagnostics, HANDLER_FAILED, error, { actionName });
      const fault: RuntimeFault = {
        actionKey: actionName,
        exitCode: -1,
        stderrExcerpt: errorText(error),
      };
      end({ phase: 'error', actionName, elementKey, fault });
    }
  };
}
