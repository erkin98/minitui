import type { DispatchContext, ActionOutcome } from '@minitui/renderer-core';

export interface CallbackDeps {
  /** The catalog's frozen set of legal callback action names (the no-code gate). */
  readonly allowlist: ReadonlySet<string>;
  readonly emit: (event: {
    kind: 'agent-callback';
    name: string;
    params: Record<string, unknown>;
  }) => void;
}

/**
 * Validates the callback name against the catalog allowlist and forwards it as an agent event. An
 * off-allowlist callback is refused, never forwarded: the renderer cannot invent a capability.
 */
export function handleCallback(ctx: DispatchContext, deps: CallbackDeps): ActionOutcome {
  if (!deps.allowlist.has(ctx.actionName)) {
    return { status: 'denied', reason: 'callback not in catalog allowlist' };
  }
  deps.emit({ kind: 'agent-callback', name: ctx.actionName, params: ctx.resolvedParams });
  return { status: 'settled' };
}
