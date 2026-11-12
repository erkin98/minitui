import type { AgentSession, Effort, RedactionPolicy } from '@minitui/agent-core';
import type { SandboxManagerHandle } from '@minitui/exec';
import type { ActionDispatcher, RendererPort, WidgetCatalogBinding } from '@minitui/renderer-core';
import type { InkRendererDeps } from '@minitui/renderer-ink';
import type { AppHost, HostSession } from '@minitui/runtime-host';
import type { CapabilityProvider, composeValidation, MiniAppSpec } from '@minitui/spec';
import type { AgentPort } from '@minitui/transport';
import type { ApprovalMode, DiagnosticsPort, RuntimeFault } from '@minitui/types';
import type { GenerationContext } from './generation.js';
import type { GenerationStatusHandle } from './status-frame.js';

/** The constructor bag of the agent session, as the session itself declares it. */
export type SessionDeps = ConstructorParameters<typeof AgentSession>[0];

/**
 * The slice of the session the composition root drives: the loop feed and the repair ingress (`submit`),
 * the cancel, the live spec sink (`emitSpec`) and the thread id. A real session satisfies it, and so does
 * a small real session in a test.
 */
export type SessionLike = Pick<AgentSession, 'submit' | 'cancel' | 'emitSpec' | 'threadId'>;

/** What a repair needs of the mounted app: a way to apply a spec that passed validation. */
export type RepairTarget = Pick<HostSession, 'updateSpec'>;

/** What the run needs of a mounted app: when it ends, how to release it, and the repair target. */
export type MountedApp = Pick<HostSession, 'done' | 'dispose'> & RepairTarget;

export type ValidateFn = (
  stream: AsyncIterable<string>,
  regenerate: (reprompt: string) => AsyncIterable<string>,
) => ReturnType<typeof composeValidation>;

export interface TextSink {
  write(text: string): void;
}

export interface AppGraphDeps {
  readonly mode: ApprovalMode;
  readonly accessible: boolean;
  readonly binding: WidgetCatalogBinding;
  /** The provider with the model it runs. The entry builds the real one; a test passes a scripted one. */
  readonly route: SessionDeps['route'];
  /** The directory the person runs from, told to the model so it can write absolute paths. */
  readonly workingDirectory: string;
  /** In production `(wiring) => new AgentSession(wiring)`. */
  readonly makeSession: (wiring: SessionDeps) => SessionLike;
  /** Where warnings go. Left out, they go nowhere. */
  readonly diagnostics?: DiagnosticsPort | undefined;
  /** Where the messages for the person go on a failed run. Left out, the process's standard error. */
  readonly stderr?: TextSink | undefined;
  /** Builds the sandbox handle. Left out, the real one; a test injects a real handle, active or not. */
  readonly createSandbox?: (() => Promise<SandboxManagerHandle>) | undefined;
  /** Left out, the real probe of the host's encoders and files. */
  readonly capabilities?: CapabilityProvider | undefined;
  /** The host's own secret patterns, applied wherever text goes to the model. */
  readonly redactionPolicy?: RedactionPolicy | undefined;
  /** How much the model reasons; left out, nothing is sent and the model's own default applies. */
  readonly effort?: Effort | undefined;
  /** The renderer; left out, the Ink renderer over the shared store. A test injects a real recording one. */
  readonly renderer?: RendererPort | undefined;
  /** Streams for the Ink renderer; left out, the real terminal. */
  readonly rendererIo?: InkRendererDeps['io'] | undefined;
}

export interface AppGraph {
  readonly host: AppHost;
  readonly agentPort: AgentPort;
  readonly session: SessionLike;
  readonly systemPrompt: string;
  readonly capabilities: CapabilityProvider;
  readonly binding: WidgetCatalogBinding;
  readonly dispatcher: ActionDispatcher;
  /** Stops the model, the tools and every exec in flight. Sticky: see `cancelled`. */
  readonly cancel: () => void;
  /** True once `cancel` has run; nothing new is generated after that. */
  readonly cancelled: () => boolean;
  /** Mounts the generation status line; its Esc cancels. */
  readonly mountStatus: () => GenerationStatusHandle;
  /** A gated action failed after mount: re-ask the model, validate, and apply the repaired spec. */
  readonly observeFault: (fault: RuntimeFault) => void;
  /** A gated action was refused: logged, never repaired. */
  readonly observeDenied: (denial: { readonly actionKey: string; readonly reason: string }) => void;
  /** The mounted app the repair applies to; undefined before the mount and after it ends. */
  readonly bindHostSession: (session: RepairTarget | undefined) => void;
  readonly diagnostics: DiagnosticsPort;
  readonly stderr: TextSink;
  /** The intent and the last reply, kept so every regeneration prompt can carry them. */
  readonly generation: GenerationContext;
  /** One line for the person when the sandbox is inactive; undefined when it is active. */
  readonly sandboxNotice: string | undefined;
  /** Awaits the sandbox's release. */
  readonly dispose: () => Promise<void>;
  readonly validate: ValidateFn;
}

/** What `runApp` consumes. The full graph satisfies it, and so does a small real one in a test. */
export interface RunAppGraph {
  readonly host: { mount(spec: MiniAppSpec): Promise<MountedApp> };
  readonly agentPort: AgentPort;
  readonly session: Pick<SessionLike, 'emitSpec'>;
  readonly mountStatus: () => GenerationStatusHandle;
  readonly validate: ValidateFn;
  readonly diagnostics: DiagnosticsPort;
  readonly stderr: TextSink;
  readonly cancelled: () => boolean;
  readonly bindHostSession: (session: RepairTarget | undefined) => void;
  readonly generation: GenerationContext;
}

/** What the entry drives: the run, plus the cancel and the teardown. */
export type CliGraph = RunAppGraph & Pick<AppGraph, 'cancel' | 'sandboxNotice' | 'dispose'>;
