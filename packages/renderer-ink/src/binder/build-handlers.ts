import type { ActionDispatcher, ActionLifecycleEvent } from '@minitui/renderer-core';
import type { MinituiCatalog } from '@minitui/catalog';
import type { JsonValue } from '@minitui/types';
import { gatedHandler } from './gated-handler.js';
import { isRenderLocalAllowed } from './render-local.js';

export interface BuildHandlersArgs {
  readonly catalog: MinituiCatalog;
  readonly dispatcher: ActionDispatcher;
  readonly getState: () => JsonValue; // single thunk — the same shape json-render uses for getState
  readonly emitLifecycle: (e: ActionLifecycleEvent) => void;
}

// json-render handlers receive ONLY (params) — no element-key channel exists. prepareSpec
// (mount) injects the firing element's key into every gated binding's params under this
// name; we read it here, strip it, and thread it into DispatchContext.elementKey.
export const ELEMENT_KEY = '__minituiElementKey';

function takeElementKey(params: Record<string, unknown>): {
  key: string;
  clean: Record<string, unknown>;
} {
  const raw = params[ELEMENT_KEY];
  const key = typeof raw === 'string' ? raw : '';
  if (!(ELEMENT_KEY in params)) return { key, clean: params };
  const clean = { ...params };
  delete clean[ELEMENT_KEY];
  return { key, clean };
}

// json-render's ActionProvider natively implements log (a raw console.log — a sanitizer
// bypass) and exit (process control); a custom handler SHADOWS the native one, so
// rejectors are always installed for both, even when the catalog omits them.
const REJECTED_NATIVE_BUILTINS = ['log', 'exit'] as const;

function rejecting(name: string): (params: Record<string, unknown>) => Promise<void> {
  return () =>
    Promise.reject(new Error(`render-local action "${name}" is not in the STATE-ONLY allowlist`));
}

export function buildHandlers(
  args: BuildHandlersArgs,
): Record<string, (params: Record<string, unknown>) => Promise<void>> {
  const { catalog, dispatcher, getState, emitLifecycle } = args;
  const handlers: Record<string, (params: Record<string, unknown>) => Promise<void>> = {};

  for (const [name, def] of catalog.actionDefs) {
    if (def.kind === 'render-local') {
      if (!isRenderLocalAllowed(name)) {
        handlers[name] = rejecting(name);
      }
      // allowlisted STATE mutator: OMIT — json-render ActionProvider's native built-in
      // writes the controlled store (actions.tsx:167-215); a map entry here would shadow it.
      continue;
    }
    // exec-local | exec-mcp | agent-callback — gated.
    const gated = gatedHandler({
      actionName: name,
      def,
      dispatcher,
      getStateSnapshot: getState,
      emitLifecycle,
    });
    handlers[name] = async (params) => {
      const { key, clean } = takeElementKey(params);
      await gated(clean, key);
    };
  }

  for (const name of REJECTED_NATIVE_BUILTINS) {
    if (!handlers[name]) handlers[name] = rejecting(name);
  }
  return handlers;
}
