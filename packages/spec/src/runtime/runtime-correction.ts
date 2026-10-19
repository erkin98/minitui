import { sanitize } from '@minitui/catalog';
import type { RuntimeError } from './runtime-error.js';

export interface RuntimeRepair {
  readonly code: 'RUNTIME_ERROR';
  readonly fixable: boolean;
  readonly actionKey: string;
  /** The reprompt text fed back to the agent to repair the spec/action. */
  readonly reprompt: string;
}

/**
 * Turn a non-zero exec result into a fixable RUNTIME_ERROR the agent can repair.
 * `@minitui/spec` is the SOLE owner of the fault→envelope→reprompt build: every
 * fault — the exec/MCP failure round-trip AND the off-catalog
 * render-reject (caught host-side) — routes through THIS one builder,
 * never a second fault→string function. `wording` is the catalog-domain remedy
 * hint (`@minitui/catalog`'s `CATALOG_REPAIR_WORDING`) injected by the caller:
 * catalog contributes the wording → this builds the envelope+reprompt →
 * agent-core's observation-router calls it (agent-core cannot import catalog, so
 * the composition root injects the string). When `wording` is omitted the builder
 * uses a generic remedy line, so it stands alone for any non-catalog fault. A zero
 * exit carries nothing to fix. This is the stderr round-trip the Artifacts failure
 * (errors never returned to the model) is missing. The action key and the stderr excerpt are untrusted
 * text: both go through the shared `sanitize` before they reach the model (CR, TAB and LF are kept); the
 * returned `actionKey` field is the value as given.
 */
export function toRuntimeRepair(err: RuntimeError, wording?: string): RuntimeRepair {
  const fixable = err.exitCode !== 0;
  const remedy = wording ?? 'Regenerate the spec to avoid this error.';
  const reprompt = fixable
    ? `The action "${sanitize(err.actionKey)}" failed (exit ${err.exitCode}). The tool reported:\n${sanitize(err.stderrExcerpt)}\n${remedy}`
    : '';
  return { code: 'RUNTIME_ERROR', fixable, actionKey: err.actionKey, reprompt };
}
