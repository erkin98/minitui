import { videoMergeCatalog } from '@minitui/catalog';
import type { ToolCallRequest, ToolCallResult, ToolDispatchPort } from '@minitui/agent-core';
import type { AppHost } from '@minitui/runtime-host';
import type { ExecEvent } from '@minitui/types';

/**
 * The model loop's only way to run anything. A tool call enters through the host router, which refuses an
 * action the model may not call, puts the live state values over the parameters, checks them and only then
 * reaches the gate: the model has no path to exec that goes around it. A refused turn or a name that is
 * not a dispatchable catalog action is refused here, at the port, as a denial.
 *
 * The turn's signal is only checked on entry. It is not linked into the run's own controller: the session
 * aborts a turn's signal when the turn ends, and a link would cancel every dispatch that came after.
 */
export function makeToolDispatch(
  host: Pick<AppHost, 'dispatchFromModel'>,
  onExecEvent: (ev: ExecEvent) => void,
): ToolDispatchPort {
  return {
    async dispatch(req: ToolCallRequest, signal: AbortSignal): Promise<ToolCallResult> {
      const base = { toolCallId: req.toolCallId, toolName: req.toolName };
      if (signal.aborted) {
        return { ...base, ok: false, content: '', isError: true, error: 'cancelled' };
      }
      const kind = videoMergeCatalog.kindOf(req.toolName);
      if (kind === undefined || kind === 'render-local') {
        return {
          ...base,
          ok: false,
          content: '',
          isError: true,
          denied: true,
          error: `not a dispatchable catalog action: ${req.toolName}`,
        };
      }
      const permission = videoMergeCatalog.permissionOf(req.toolName);
      const outcome = await host.dispatchFromModel(req.toolName, {
        actionName: req.toolName,
        actionKind: kind,
        ...(permission !== undefined ? { permission } : {}),
        resolvedParams: { ...req.args },
        stateSnapshot: {},
        elementKey: '',
        onEvent: onExecEvent,
      });
      switch (outcome.status) {
        case 'settled':
          return {
            ...base,
            ok: true,
            content: JSON.stringify(outcome.result ?? null),
            isError: false,
          };
        case 'denied':
          return {
            ...base,
            ok: false,
            content: '',
            isError: true,
            denied: true,
            error: outcome.reason,
          };
        case 'awaiting':
          return {
            ...base,
            ok: false,
            content: '',
            isError: true,
            error: `awaiting user consent (${outcome.requestId})`,
          };
        case 'failed':
          return {
            ...base,
            ok: false,
            content: '',
            isError: true,
            error: outcome.fault.stderrExcerpt,
          };
      }
    },
  };
}
