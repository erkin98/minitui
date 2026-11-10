import type { ActionDispatcher, ActionOutcome, DispatchContext } from '@minitui/renderer-core';
import {
  JsonValueSchema,
  type ActionKind,
  type PermissionDescriptor,
  type RuntimeFault,
} from '@minitui/types';
import type { HostState } from './state.js';

// Fixed refusal texts. None carries a value that came from a spec, a renderer or the model.
export const UNKNOWN_ACTION = 'action is not in the catalog';
export const CONTEXT_MISMATCH = 'action context does not match the catalog';
export const HOLE_NOT_A_POINTER = 'a template hole is not a state pointer';
export const NO_LIVE_VALUE = 'a consent value has no live state backing';
export const PARAMS_REFUSED = 'action parameters do not match the catalog after host resolution';
const NOT_ALLOWED = 'render-local action is not in the state allowlist';
const NOT_A_POINTER = 'render-local action needs a state pointer';
const NOT_JSON = 'render-local action needs a JSON value';
const BAD_INDEX = 'render-local action needs a non-negative integer index';

export interface ActionRouterDeps {
  /** The state the render-local actions write and the consent values are read from. */
  readonly state: HostState;
  /** The exec-side dispatcher, injected by the composition root. */
  readonly exec: ActionDispatcher;
  /** The catalog's kind of an action. The router never trusts the kind a renderer put in a context. */
  readonly kindOf: (actionName: string) => ActionKind | undefined;
  /** The catalog's permission descriptor of an action, for the same reason. */
  readonly permissionOf: (actionName: string) => PermissionDescriptor | undefined;
  /** The action's own parameter check, run on the final parameters after the live values are in. */
  readonly checkParams: (actionName: string, params: Readonly<Record<string, unknown>>) => boolean;
  /** A gated action ended in a failure; the fault goes back to the agent that built the app. */
  readonly observeFault?: ((fault: RuntimeFault) => void) | undefined;
  /** A gated action was refused here or by exec; reported once, never repaired. */
  readonly observeDenied?:
    | ((denial: { readonly actionKey: string; readonly reason: string }) => void)
    | undefined;
}

const SETTLED: ActionOutcome = { status: 'settled' };
const denied = (reason: string): ActionOutcome => ({ status: 'denied', reason });

// A pointer in the form the store understands: it starts with a slash and every tilde is an escape.
const isPointer = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('/') && !/~(?![01])/.test(value);

const unescapeSegment = (segment: string): string =>
  segment.replace(/~1/g, '/').replace(/~0/g, '~');

/**
 * The render-local actions: the state trio, in the shapes json-render's own built-ins take. Anything
 * else is refused, and so is a parameter the store would silently drop: the store logs a write it
 * cannot take and returns, so the host looks first and refuses what it can see is invalid.
 */
/**
 * The actions a renderer may run locally: json-render's state trio, and nothing else. Exported so the
 * integration package can check it equals renderer-ink's own list, which this package cannot import.
 */
export const RENDER_LOCAL_ACTIONS: ReadonlySet<string> = new Set([
  'setState',
  'pushState',
  'removeState',
]);

function routeRenderLocal(
  actionName: string,
  params: Readonly<Record<string, unknown>>,
  state: HostState,
): ActionOutcome {
  if (!RENDER_LOCAL_ACTIONS.has(actionName)) return denied(NOT_ALLOWED);
  const path = params.statePath;
  if (!isPointer(path)) return denied(NOT_A_POINTER);
  if (actionName === 'removeState') {
    const index = params.index;
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
      return denied(BAD_INDEX);
    }
    state.removeState(path, index);
    return SETTLED;
  }
  const value = JsonValueSchema.safeParse(params.value);
  if (!value.success) return denied(NOT_JSON);
  if (actionName === 'setState') {
    state.setState(path, value.data);
    return SETTLED;
  }
  // An empty clear path means "clear nothing", as it does in json-render's own pushState.
  const clear = params.clearStatePath === '' ? undefined : params.clearStatePath;
  if (clear !== undefined && !isPointer(clear)) return denied(NOT_A_POINTER);
  state.pushState(path, value.data);
  if (clear !== undefined) state.setState(clear, '');
  return SETTLED;
}

const HOLE_RE = /\$\{([^}]*)\}/g;

/**
 * The first segment of every hole in the two templates, still escaped, or undefined when a hole is not
 * a state pointer. Exec fills the headline from the parameters for every kind and, for the kinds that
 * are not a local merge, the resource template too; a local merge reads its typed slots directly. So the
 * roots of both templates are the values the consent box can show, and all of them are read from the
 * live state.
 */
function holeRoots(permission: PermissionDescriptor | undefined): readonly string[] | undefined {
  const roots = new Set<string>();
  for (const template of [permission?.resourceTemplate ?? '', permission?.summaryTemplate ?? '']) {
    for (const match of template.matchAll(HOLE_RE)) {
      const content = match[1] ?? '';
      if (!content.startsWith('/')) return undefined;
      roots.add(content.split('/')[1] ?? '');
    }
  }
  return [...roots];
}

/**
 * The context exec gets: the catalog's descriptor, the live value of every root a template names put over
 * the renderer's, and a fresh state snapshot. A root with no live value is a refusal: the renderer's copy
 * is never shown as consent. Own properties are created with fromEntries, so a root named like an
 * Object.prototype member cannot reach the prototype.
 */
function graft(
  ctx: DispatchContext,
  permission: PermissionDescriptor | undefined,
  state: HostState,
): DispatchContext | string {
  const roots = holeRoots(permission);
  if (roots === undefined) return HOLE_NOT_A_POINTER;
  const live: Array<[string, unknown]> = [];
  for (const segment of roots) {
    const value = state.getIn(`/${segment}`);
    if (value === undefined) return NO_LIVE_VALUE;
    live.push([unescapeSegment(segment), value]);
  }
  return {
    ...ctx,
    permission,
    resolvedParams: Object.fromEntries([...Object.entries(ctx.resolvedParams), ...live]),
    stateSnapshot: state.getState(),
  };
}

async function routeGated(
  actionName: string,
  ctx: DispatchContext,
  deps: ActionRouterDeps,
): Promise<ActionOutcome> {
  const resolved = graft(ctx, deps.permissionOf(actionName), deps.state);
  if (typeof resolved === 'string') return denied(resolved);
  if (!deps.checkParams(actionName, resolved.resolvedParams)) return denied(PARAMS_REFUSED);
  return deps.exec.dispatch(actionName, resolved);
}

/**
 * The host's action router. The kind, the name and the permission descriptor a renderer puts in a
 * context are claims: the catalog decides what an action is, and a context that disagrees is refused.
 * render-local actions are handled here against the shared state; the gated kinds go to exec after the
 * live consent values are in.
 */
export function createActionRouter(deps: ActionRouterDeps): ActionDispatcher {
  const report = (actionName: string, outcome: ActionOutcome): ActionOutcome => {
    if (outcome.status === 'failed') deps.observeFault?.(outcome.fault);
    if (outcome.status === 'denied') {
      deps.observeDenied?.({ actionKey: actionName, reason: outcome.reason });
    }
    return outcome;
  };
  return {
    async dispatch(actionName: string, ctx: DispatchContext): Promise<ActionOutcome> {
      const kind = deps.kindOf(actionName);
      if (kind === undefined) return report(actionName, denied(UNKNOWN_ACTION));
      if (ctx.actionName !== actionName || ctx.actionKind !== kind) {
        return report(actionName, denied(CONTEXT_MISMATCH));
      }
      if (kind === 'render-local')
        return routeRenderLocal(actionName, ctx.resolvedParams, deps.state);
      return report(actionName, await routeGated(actionName, ctx, deps));
    },
  };
}
