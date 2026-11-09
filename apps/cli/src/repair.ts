import { routeRuntimeFault, type RedactionPolicy } from '@minitui/agent-core';
import { CATALOG_REPAIR_WORDING, videoMergeCatalog } from '@minitui/catalog';
import { composeValidation, toRuntimeRepair, type CapabilityProvider } from '@minitui/spec';
import type { DiagnosticsPort, RuntimeFault } from '@minitui/types';
import {
  composeRegenerationPrompt,
  emptyTextStream,
  repairTextOf,
  teeText,
  type GenerationContext,
} from './generation.js';
import type { RepairTarget, SessionLike } from './graph-types.js';

const ERROR_CAP = 500;

/**
 * The repair of an app that failed after it was mounted. A gated action that fails sends its fault here;
 * the fault is redacted and put to the still-running session as a new turn, the reply goes through the
 * same catalog validation as the first generation, and only a spec that passed is applied to the mounted
 * app. An unvalidated spec is never applied. A refused action is not a fault of the spec and does not come
 * here; a failure with the sandbox inactive does not either, since no spec change would help.
 */
export function createRepairBridge(deps: {
  readonly session: () => SessionLike;
  readonly sandboxActive: boolean;
  readonly diagnostics: DiagnosticsPort;
  readonly capabilities: CapabilityProvider;
  readonly generation: GenerationContext;
  readonly redactionPolicy: RedactionPolicy | undefined;
  readonly isCancelled: () => boolean;
}): {
  observeFault: (fault: RuntimeFault) => void;
  bindHostSession: (session: RepairTarget | undefined) => void;
} {
  let mounted: RepairTarget | undefined;
  // The fault wording comes from the spec package and the catalog's domain words; the prompt around it
  // carries the user's intent and the text of the spec that is mounted, since a turn is stateless.
  const buildRepair = (fault: RuntimeFault): string =>
    composeRegenerationPrompt({
      intent: deps.generation.intent,
      previousText: deps.generation.previousText,
      reprompt: toRuntimeRepair(fault, CATALOG_REPAIR_WORDING).reprompt,
    });

  const repair = async (fault: RuntimeFault): Promise<void> => {
    const session = deps.session();
    const repaired = await composeValidation({
      stream: teeText(
        repairTextOf(routeRuntimeFault(fault, session, buildRepair, deps.redactionPolicy)),
        deps.generation,
      ),
      catalog: videoMergeCatalog,
      capabilities: deps.capabilities,
      regenerate: (reprompt) => {
        if (deps.isCancelled()) return emptyTextStream();
        const prompt = composeRegenerationPrompt({
          intent: deps.generation.intent,
          previousText: deps.generation.previousText,
          reprompt,
        });
        return teeText(repairTextOf(session.submit(prompt)), deps.generation);
      },
    });
    if (repaired.ok) {
      mounted?.updateSpec(repaired.spec);
    } else {
      deps.diagnostics.warn('post-mount repair produced no valid spec', {
        attempts: repaired.lastEnvelope.attempt,
        firstAttempt: repaired.firstEnvelope.attempt,
      });
    }
  };

  return {
    bindHostSession: (session) => {
      mounted = session;
    },
    observeFault: (fault) => {
      if (!deps.sandboxActive) {
        deps.diagnostics.warn('gated action failed with the sandbox unavailable', {
          actionKey: fault.actionKey,
        });
        return;
      }
      // The host calls this and does not wait: the failed outcome is on screen already, and a repair that
      // throws (a dead provider) must not become an unhandled rejection.
      void repair(fault).catch((err: unknown) => {
        deps.diagnostics.warn('reprompt turn failed', { error: String(err).slice(0, ERROR_CAP) });
      });
    },
  };
}
