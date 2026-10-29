import { boundFaultText, handleExecLocal, type ExecLocalDeps } from './exec-local-handler.js';
import { handleCallback, type CallbackDeps } from './callback-handler.js';
import type { Decision, PermissionRequest } from '@minitui/types';
import type { ActionDispatcher, DispatchContext, ActionOutcome } from '@minitui/renderer-core';

export interface ActionRouterDeps {
  readonly engine: { check(req: PermissionRequest): Promise<Decision> };
  readonly execLocal: Omit<ExecLocalDeps, 'signal'>;
  readonly callback: CallbackDeps;
  /** Builds the gate request from RESOLVED context values, never from the agent's template. */
  readonly buildPermissionRequest: (ctx: DispatchContext) => PermissionRequest;
  readonly signal: AbortSignal;
}

/** The text of a thrown value. A non-Error carries no host text, and its own toString is never run. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'unexpected failure';
}

function denied(err: unknown): ActionOutcome {
  return { status: 'denied', reason: boundFaultText(messageOf(err)) };
}

/**
 * The permission gate, by kind. exec-mcp skips this generic gate: it is shaped for local commands and
 * callbacks, and the MCP handler owns its own gate. The sandbox guard already ran for every kind.
 * Returns the outcome that ends the dispatch, or null to go on.
 */
async function gate(ctx: DispatchContext, deps: ActionRouterDeps): Promise<ActionOutcome | null> {
  if (ctx.actionKind === 'exec-mcp') return null;
  let decision: Decision;
  try {
    // The request builder throws on a relative or metacharacter-bearing resolved path and on a missing
    // descriptor; that is a refusal before the engine, never an escaped rejection.
    decision = await deps.engine.check(deps.buildPermissionRequest(ctx));
  } catch (err) {
    return denied(err);
  }
  if (decision.kind === 'deny') return { status: 'denied', reason: decision.reason };
  // The engine blocks inside `check` until the person replies, so an `ask` should never come back;
  // if one does, nothing runs.
  if (decision.kind === 'ask') return { status: 'denied', reason: 'approval did not resolve' };
  return null;
}

/** Routes an allowed action by kind; a thrown failure becomes a failed outcome and never escapes. */
async function route(
  actionName: string,
  ctx: DispatchContext,
  deps: ActionRouterDeps,
): Promise<ActionOutcome> {
  try {
    switch (ctx.actionKind) {
      case 'exec-local':
        return await handleExecLocal(ctx, { ...deps.execLocal, signal: deps.signal });
      case 'agent-callback':
        return handleCallback(ctx, deps.callback);
      case 'exec-mcp':
        // No handler yet: refuse rather than silently do nothing.
        return { status: 'denied', reason: 'exec-mcp is not available in this version' };
      default:
        return { status: 'denied', reason: 'unknown action kind' };
    }
  } catch (err) {
    // A thrown message is fault text too: sanitised and windowed like the stderr excerpt.
    return {
      status: 'failed',
      fault: { actionKey: actionName, exitCode: -1, stderrExcerpt: boundFaultText(messageOf(err)) },
    };
  }
}

/**
 * The exec-side dispatcher: sandbox guard, then the permission gate, then execute, then map failures.
 * render-local is state-only and handled in the renderer, so it is refused here by design.
 */
export function createActionRouter(deps: ActionRouterDeps): ActionDispatcher {
  return {
    async dispatch(actionName, ctx): Promise<ActionOutcome> {
      if (ctx.actionKind === 'render-local') {
        return {
          status: 'denied',
          reason: 'render-local is state-only and not routed through exec',
        };
      }
      // Fail closed first: with no active sandbox every gated kind is refused before the permission
      // engine is consulted, which must never see a request the sandbox cannot enforce.
      try {
        deps.execLocal.sandbox.assertGatable(ctx.actionKind);
      } catch (err) {
        return denied(err);
      }
      const refusal = await gate(ctx, deps);
      return refusal ?? (await route(actionName, ctx, deps));
    },
  };
}
