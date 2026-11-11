import type {
  ActionDispatcher,
  ActionOutcome,
  DispatchContext,
  LifecycleEmitter,
  RenderHandle,
  RendererPort,
  WidgetCatalogBinding,
} from '@minitui/renderer-core';
import { toWireSpec, type MiniAppSpec } from '@minitui/spec';
import type { DataStore } from '@minitui/transport';
import type {
  ActionKind,
  JsonPatch,
  PermissionDescriptor,
  RuntimeFault,
  VisibilityClass,
} from '@minitui/types';
import { createActionRouter } from './dispatcher.js';
import { createHostState, type HostState } from './state.js';

export interface AppHostDeps {
  readonly renderer: RendererPort;
  readonly binding: WidgetCatalogBinding;
  /** The exec-side dispatcher, injected by the composition root. */
  readonly dispatcher: ActionDispatcher;
  /** The one shared data store: the same instance the renderer's state adapter wraps. */
  readonly store: DataStore;
  /** The action's own parameter check, built from the catalog; run on the final parameters. */
  readonly checkParams: (actionName: string, params: Readonly<Record<string, unknown>>) => boolean;
  /** The catalog's callability class of an action; only `remoteOnly` actions may be called by the model. */
  readonly callableFromOf: (actionName: string) => VisibilityClass | undefined;
  /** The catalog's kind of an action; a context that disagrees with it is refused. */
  readonly kindOf: (actionName: string) => ActionKind | undefined;
  /** The catalog's permission descriptor; the router dispatches this one and ignores the renderer's. */
  readonly permissionOf: (actionName: string) => PermissionDescriptor | undefined;
  /** A gated action failed: the cli routes the fault back to the agent session that built the app. */
  readonly observeFault?: ((fault: RuntimeFault) => void) | undefined;
  /** A gated action was refused; reported once, never repaired. */
  readonly observeDenied?:
    | ((denial: { readonly actionKey: string; readonly reason: string }) => void)
    | undefined;
  readonly onLifecycle?: LifecycleEmitter | undefined;
  /** Screen-reader mode, forwarded to the renderer. */
  readonly accessible?: boolean | undefined;
}

export interface AppHost {
  /** Mounts a spec that was validated already. Everything else is a dependency given at creation. */
  mount(spec: MiniAppSpec): Promise<HostSession>;
  /**
   * The model's entrance to actions: refused unless the action is `remoteOnly`, otherwise it goes
   * through the same router as a widget press. The model reaches the exec dispatcher no other way.
   */
  dispatchFromModel(actionName: string, ctx: DispatchContext): Promise<ActionOutcome>;
}

/** The refusal of the model entrance for an action the model may not call. */
export const MODEL_NOT_CALLABLE = 'action is not callable by the model';

/** How the interactive phase ended; the cli derives the process exit code from it. */
export interface TaskOutcome {
  readonly status: 'completed' | 'cancelled' | 'failed';
  readonly exitCode: number;
}

export interface HostSession {
  readonly state: HostState;
  /** The agent's state patches: folded into the one shared store, which tells the renderer. */
  applyStatePatch(patch: readonly JsonPatch[]): void;
  getSpec(): MiniAppSpec;
  /**
   * Applies a repaired spec the caller validated already: re-seeds the state, re-renders, and updates
   * getSpec. A throw from the renderer is rolled back and sent to observeFault, except for a refusal
   * that means the app was built wrong, which is rethrown.
   */
  updateSpec(spec: MiniAppSpec): void;
  /** Settles once the app is quit or finished, never at mount. The cli awaits it before restoring the terminal. */
  readonly done: Promise<TaskOutcome>;
  /** Settles `done`; the first call wins. The quit keys and the cli's signal handling route here. */
  requestQuit(outcome: TaskOutcome): void;
  /** Unmounts the renderer. A `done` still pending settles as cancelled with exit 130. */
  dispose(): void;
}

/** A renderer refusal or throw as the fault the repair path takes. Redaction happens downstream. */
function renderFault(err: unknown): RuntimeFault {
  return {
    actionKey: 'render',
    exitCode: 1,
    stderrExcerpt: err instanceof Error ? err.message : 'the renderer refused the spec',
  };
}

// These two refusal codes mean the app was built wrong, so there is nothing to repair; the other
// refusals describe the generated spec and go to the repair path like an off-catalog throw.
const BUILDER_REFUSALS: ReadonlySet<string> = new Set([
  'unbound-component',
  'initial-state-unsupported',
]);

function isBuilderRefusal(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    typeof err.code === 'string' &&
    BUILDER_REFUSALS.has(err.code)
  );
}

export function createAppHost(deps: AppHostDeps): AppHost {
  const state: HostState = createHostState(deps.store);
  const router = createActionRouter({
    state,
    exec: deps.dispatcher,
    kindOf: deps.kindOf,
    permissionOf: deps.permissionOf,
    checkParams: deps.checkParams,
    observeFault: deps.observeFault,
    observeDenied: deps.observeDenied,
  });

  return {
    dispatchFromModel(actionName: string, ctx: DispatchContext): Promise<ActionOutcome> {
      if (deps.callableFromOf(actionName) !== 'remoteOnly') {
        return Promise.resolve({ status: 'denied', reason: MODEL_NOT_CALLABLE });
      }
      return router.dispatch(actionName, ctx);
    },
    async mount(spec: MiniAppSpec): Promise<HostSession> {
      // Seed first, so the renderer's first read of the shared store sees the validated model.
      const beforeMount = state.getState();
      state.seed(spec.state);
      let currentSpec = spec;

      // done and requestQuit exist before the renderer mounts, because the quit-key callbacks below
      // close over requestQuit. The deferred belongs to this mount, so no other quit can settle it.
      let settled = false;
      let settle!: (outcome: TaskOutcome) => void;
      const done = new Promise<TaskOutcome>((resolve) => {
        settle = resolve;
      });
      const requestQuit = (outcome: TaskOutcome): void => {
        if (settled) return;
        settled = true;
        settle(outcome);
      };

      let handle: RenderHandle;
      try {
        handle = await deps.renderer.mount({
          spec: toWireSpec(spec),
          binding: deps.binding,
          dispatcher: router,
          onLifecycle: deps.onLifecycle,
          accessible: deps.accessible,
          onQuit: () => requestQuit({ status: 'completed', exitCode: 0 }),
          onCancel: () => requestQuit({ status: 'cancelled', exitCode: 130 }),
        });
      } catch (err) {
        // The renderer refused: fail closed with no session, and leave the store as it was found.
        state.seed(beforeMount);
        if (!isBuilderRefusal(err)) deps.observeFault?.(renderFault(err));
        throw err;
      }

      return {
        state,
        // One store, one apply: the store tells the renderer, so the handle's own patch method stays
        // unused. Calling it as well would fold an append like `add /inputs/-` twice.
        applyStatePatch: (patch) => state.applyStatePatch(patch),
        getSpec: () => currentSpec,
        updateSpec: (next: MiniAppSpec) => {
          const previousSpec = currentSpec;
          const previousState = state.getState();
          try {
            state.seed(next.state);
            currentSpec = next;
            handle.update(toWireSpec(next));
          } catch (err) {
            // Roll back first, so a rejected repair never leaves getSpec or the store on it.
            currentSpec = previousSpec;
            state.seed(previousState);
            if (isBuilderRefusal(err)) throw err;
            deps.observeFault?.(renderFault(err));
          }
        },
        done,
        requestQuit,
        dispose: () => {
          // An abnormal teardown must never leave `await session.done` hanging.
          requestQuit({ status: 'cancelled', exitCode: 130 });
          handle.unmount();
        },
      };
    },
  };
}
