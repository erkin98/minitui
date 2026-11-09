import {
  catalogVisibilityToChannel,
  createSpecSink,
  createVisibilityChannel,
} from '@minitui/agent-core';
import { buildCatalogPrompt, videoMergeCatalog } from '@minitui/catalog';
import { createInkRenderer } from '@minitui/renderer-ink';
import { createAppHost } from '@minitui/runtime-host';
import { composeValidation } from '@minitui/spec';
import { createDataStore, createLocalAgentPort, type AgentPort } from '@minitui/transport';
import { noopDiagnostics } from '@minitui/types';
import { hostCatalogDeps } from './catalog-deps.js';
import { makeConsentController } from './consent.js';
import { buildExecStack } from './exec-stack.js';
import { MAX_GEN_ATTEMPTS, createGenerationContext } from './generation.js';
import type { AppGraph, AppGraphDeps, SessionLike } from './graph-types.js';
import { createRepairBridge } from './repair.js';
import { mountGenerationStatus } from './status-frame.js';
import { bindExecEventToStore, createRendererStoreIo } from './store-bridge.js';
import { makeToolDispatch } from './tool-dispatch.js';

/**
 * The longest reply the model may give: room for its thinking, which counts against this cap, and
 * then a whole spec or the text of a repair. A reply cut by the cap ends the run, so it is generous;
 * it is a ceiling, not what a reply costs.
 */
export const MAX_OUTPUT_TOKENS = 64_000;

// The last user message of the run input is the intent the local session replays.
function textOf(input: { messages?: ReadonlyArray<{ content?: unknown }> }): string {
  const last = input.messages?.[input.messages.length - 1];
  return typeof last?.content === 'string' ? last.content : '';
}

/**
 * The composition root: the one place that names concrete implementations and wires them. Bottom up: the
 * shared store, the exec stack, the renderer, the host over them, then the session whose tool port enters
 * through that host. Nothing here renders; the status line and the app are mounted by `runApp`.
 */
export async function buildAppGraph(deps: AppGraphDeps): Promise<AppGraph> {
  const diagnostics = deps.diagnostics ?? noopDiagnostics;
  const stderr = deps.stderr ?? process.stderr;

  // The one store. Its snapshot-delta path is the sanitised entry for state, and exec progress is
  // written into it through the bridge.
  const dataStore = createDataStore({ initial: {}, diagnostics });
  const onExecEvent = bindExecEventToStore(dataStore);

  const stack = await buildExecStack({
    mode: deps.mode,
    diagnostics,
    onExecEvent,
    createSandbox: deps.createSandbox,
    capabilities: deps.capabilities,
  });
  const catalogPrompt = buildCatalogPrompt(videoMergeCatalog);
  const generation = createGenerationContext();

  // The session is built after the host (its tool port enters through the host), and the repair needs the
  // session, so the repair reads it late.
  const sessionRef: { current?: SessionLike } = {};
  let cancelRequested = false;
  const repair = createRepairBridge({
    session: () => {
      if (sessionRef.current === undefined) throw new Error('the session is not built yet');
      return sessionRef.current;
    },
    sandboxActive: stack.sandbox.active,
    diagnostics,
    capabilities: stack.capabilities,
    generation,
    redactionPolicy: deps.redactionPolicy,
    isCancelled: () => cancelRequested,
  });
  const observeDenied: AppGraph['observeDenied'] = (denial) => {
    diagnostics.warn('gated action refused', {
      actionKey: denial.actionKey,
      reason: denial.reason,
    });
  };

  const host = createAppHost({
    renderer:
      deps.renderer ??
      createInkRenderer({
        catalog: videoMergeCatalog,
        store: createRendererStoreIo(dataStore),
        consent: makeConsentController(stack.permission),
        diagnostics,
        ...(deps.rendererIo !== undefined ? { io: deps.rendererIo } : {}),
      }),
    binding: deps.binding,
    dispatcher: stack.dispatcher,
    store: dataStore,
    accessible: deps.accessible,
    observeFault: repair.observeFault,
    observeDenied,
    ...hostCatalogDeps(videoMergeCatalog),
  });

  const built = deps.makeSession({
    provider: deps.provider,
    diagnostics,
    toolDispatch: makeToolDispatch(host, onExecEvent),
    specSink: createSpecSink(),
    visibility: createVisibilityChannel(catalogVisibilityToChannel(videoMergeCatalog)),
    // No tool is registered with the model: actions fire from the mounted app through the dispatcher.
    tools: [],
    model: deps.model,
    config: {
      system: catalogPrompt,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      ...(deps.redactionPolicy !== undefined ? { redactionPolicy: deps.redactionPolicy } : {}),
    },
  });
  sessionRef.current = built;

  // The in-process agent feeds transport through this one adapter, so transport imports nothing of the
  // agent package, and the run's abort signal reaches the session.
  const agentPort: AgentPort = createLocalAgentPort((input, signal) =>
    built.submit(textOf(input), { signal }),
  );

  // Unwinds the run before the terminal is touched: the model and its tools, then every exec in flight.
  const cancel = (): void => {
    cancelRequested = true;
    built.cancel();
    stack.abort();
  };

  return {
    host,
    agentPort,
    session: built,
    catalogPrompt,
    capabilities: stack.capabilities,
    binding: deps.binding,
    dispatcher: stack.dispatcher,
    cancel,
    cancelled: () => cancelRequested,
    mountStatus: () => mountGenerationStatus({ maxAttempts: MAX_GEN_ATTEMPTS, onCancel: cancel }),
    observeFault: repair.observeFault,
    observeDenied,
    bindHostSession: repair.bindHostSession,
    diagnostics,
    stderr,
    generation,
    sandboxNotice: stack.sandboxNotice,
    dispose: async () => {
      await stack.sandbox.dispose();
    },
    validate: (stream, regenerate) =>
      composeValidation({
        stream,
        catalog: videoMergeCatalog,
        capabilities: stack.capabilities,
        regenerate,
      }),
  };
}
