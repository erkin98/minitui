import { routeRuntimeFault, type RedactionPolicy } from '@minitui/agent-core';
import { CATALOG_REPAIR_WORDING, videoMergeCatalog } from '@minitui/catalog';
import {
  composeValidation,
  toRuntimeRepair,
  type CapabilityProvider,
  type MiniAppSpec,
} from '@minitui/spec';
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

// The repairs one app session may start; the fault after the last one stays on screen and costs no turn.
const REPAIR_BUDGET = 3;

/**
 * The repair of an app that failed after it was mounted. A gated action that fails sends its fault here;
 * the fault is redacted and put to the still-running session as a new turn, the reply goes through the
 * same catalog validation as the first generation, and only a spec that passed is applied to the mounted
 * app. An unvalidated spec is never applied. A refused action is not a fault of the spec and does not come
 * here.
 *
 * A fault starts no turn, and is logged with the reason, when: the sandbox is inactive (no spec change
 * would help); the run was cancelled; no app is mounted; the fault is the host's refusal of a repaired
 * spec being applied; a repair is already running; or this app session has used its three repairs.
 *
 * Each repair has its own context: its first prompt quotes the text of the spec on screen, and its
 * regenerations quote its own last reply. An apply reads the app bound at that moment; a run binds one.
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
  // The text of the spec on screen, which a repair's first prompt quotes.
  let mountedText = '';
  let started = 0;
  let running = false;
  let applying = false;
  let applyRefused = false;

  // The fault wording comes from the spec package and the catalog's domain words; the prompt around it
  // carries the user's intent and the text of a reply, since a turn is stateless.
  const buildRepair = (fault: RuntimeFault, ctx: GenerationContext): string =>
    composeRegenerationPrompt({
      intent: ctx.intent,
      previousText: ctx.previousText,
      reprompt: toRuntimeRepair(fault, CATALOG_REPAIR_WORDING).reprompt,
    });

  // The repaired spec reaches the app; a refusal the host reports while it applies marks it refused.
  const apply = (target: RepairTarget, spec: MiniAppSpec): boolean => {
    applying = true;
    applyRefused = false;
    try {
      target.updateSpec(spec);
    } finally {
      applying = false;
    }
    return !applyRefused;
  };

  const repair = async (fault: RuntimeFault): Promise<void> => {
    const session = deps.session();
    const ctx: GenerationContext = { intent: deps.generation.intent, previousText: mountedText };
    const repaired = await composeValidation({
      stream: teeText(
        repairTextOf(
          routeRuntimeFault(
            fault,
            session,
            (redacted) => buildRepair(redacted, ctx),
            deps.redactionPolicy,
          ),
        ),
        ctx,
      ),
      catalog: videoMergeCatalog,
      capabilities: deps.capabilities,
      regenerate: (reprompt) => {
        if (deps.isCancelled()) return emptyTextStream();
        const prompt = composeRegenerationPrompt({
          intent: ctx.intent,
          previousText: ctx.previousText,
          reprompt,
        });
        return teeText(repairTextOf(session.submit(prompt)), ctx);
      },
    });
    if (!repaired.ok) {
      deps.diagnostics.warn('post-mount repair produced no valid spec', {
        attempts: repaired.lastEnvelope.attempt,
        firstAttempt: repaired.firstEnvelope.attempt,
      });
      return;
    }
    const target = mounted;
    if (target !== undefined && apply(target, repaired.spec)) mountedText = ctx.previousText;
  };

  // Why a fault starts no repair, in the order the checks run; undefined when it may start one.
  const skipReason = (): string | undefined => {
    if (!deps.sandboxActive) return 'gated action failed with the sandbox unavailable';
    if (deps.isCancelled()) return 'repair skipped: the run was cancelled';
    if (mounted === undefined) return 'repair skipped: no app is mounted';
    if (applying) {
      applyRefused = true;
      return 'repair skipped: the repaired spec was refused';
    }
    if (running) return 'repair skipped: a repair is already running';
    if (started >= REPAIR_BUDGET) return 'repair skipped: the repair budget is spent';
    return undefined;
  };

  return {
    bindHostSession: (session) => {
      mounted = session;
      if (session === undefined) started = 0;
      else mountedText = deps.generation.previousText;
    },
    observeFault: (fault) => {
      const reason = skipReason();
      if (reason !== undefined) {
        deps.diagnostics.warn(reason, { actionKey: fault.actionKey });
        return;
      }
      started += 1;
      running = true;
      // The host calls this and does not wait: the failed outcome is on screen already, and a repair that
      // throws (a dead provider) must not become an unhandled rejection.
      void repair(fault)
        .catch((err: unknown) => {
          deps.diagnostics.warn('reprompt turn failed', { error: String(err).slice(0, ERROR_CAP) });
        })
        .finally(() => {
          running = false;
        });
    },
  };
}
