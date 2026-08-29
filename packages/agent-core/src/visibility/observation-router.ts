import type { ActionResult, ExecEvent, RuntimeFault } from '@minitui/types';
import type { MinituiEvent } from '../events/index.js';
import { agentObservation } from '../events/index.js';
import type { ToolCallResult } from '../ports/tool-dispatch-port.js';
import { redact, type RedactionPolicy } from './redaction.js';

const STDERR_CAP = 4096;

export interface ObservationInput {
  readonly toolCallId: string;
  readonly result: ActionResult;
  readonly stderrExcerpt?: string | undefined;
  readonly exitCode?: number | undefined;
}

export function summarizeExecEvents(events: readonly ExecEvent[]): {
  ok: boolean;
  stderrExcerpt?: string | undefined;
  exitCode?: number | undefined;
} {
  let exitCode: number | undefined;
  let stderr = '';
  for (const e of events) {
    if (e.kind === 'stderr') stderr += e.chunk;
    else if (e.kind === 'exit') exitCode = e.code;
  }
  const ok = exitCode === 0;
  const stderrExcerpt = stderr.length > 0 ? stderr.slice(0, STDERR_CAP) : undefined;
  return { ok, stderrExcerpt, exitCode };
}

export function routeObservation(input: ObservationInput, policy?: RedactionPolicy): MinituiEvent {
  const { toolCallId, result, stderrExcerpt, exitCode } = input;
  // A non-zero exit OR result.ok === false is an error — the loop's recovery path
  // must fire, never treat a failed run as done (success = task completion, not render).
  const isError = result.ok === false || (exitCode !== undefined && exitCode !== 0);

  // Normal output stays in content; failure detail goes in the separate error slot
  // so the model can tell failure text apart from output.
  const output: string[] = [];
  if (typeof result.value === 'string') output.push(result.value);
  else if (result.value !== undefined) output.push(JSON.stringify(result.value));
  else if (!isError) output.push(`${result.actionName} ok`);

  const failure: string[] = [];
  if (isError) {
    if (result.error) failure.push(result.error);
    if (stderrExcerpt) failure.push(stderrExcerpt);
    if (exitCode !== undefined) failure.push(`exit ${exitCode}`);
    if (failure.length === 0) failure.push(`${result.actionName} failed`);
  }

  const error = isError ? redact(failure.join('\n'), policy) : undefined;
  return agentObservation({
    toolCallId,
    toolName: result.actionName,
    content: redact(output.join('\n'), policy),
    isError,
    ...(error !== undefined ? { error } : {}),
  });
}

export function routeToolCallResult(
  result: ToolCallResult,
  policy?: RedactionPolicy,
): MinituiEvent {
  // ok:false, an explicit isError, or a permission denial all fire the loop's recovery
  // path. `denied` is PRESERVED as a distinct boolean on the observation — NOT merely
  // flattened into error text — so the model can tell "the host refused this" apart from
  // "the tool broke"; the error wording is a supplementary hint, the boolean is the
  // semantic signal the loop routes on.
  const isError = result.ok === false || result.isError === true || result.denied === true;
  const errorText = result.error ?? (result.denied ? 'execution denied' : undefined);
  const contentText =
    typeof result.content === 'string' ? result.content : (JSON.stringify(result.content) ?? '');
  return agentObservation({
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    content: redact(contentText, policy),
    isError,
    ...(errorText !== undefined ? { error: redact(errorText, policy) } : {}),
    ...(result.denied ? { denied: true } : {}), // the denial flag survives to the model
  });
}

// The minimal AgentSession surface the post-mount repair bridge re-enters (submit only) —
// structural, so this module never imports the AgentSession class; AgentSession satisfies it by shape.
export interface RepairIngress {
  submit(reprompt: string, opts?: { signal?: AbortSignal }): AsyncGenerator<MinituiEvent>;
}

// @minitui/spec OWNS this wording (it owns the runtime-error envelope + compose loop); the host
// INJECTS it, so agent-core authors no wording and never imports @minitui/spec here.
export type RuntimeRepairBuilder = (fault: RuntimeFault) => string;

/**
 * The post-mount error round-trip bridge. On a failed action outcome the host hands the RuntimeFault
 * here; this REDACTS the fault's stderr excerpt (the same single chokepoint — a raw child stderr with
 * $HOME paths / secrets must never reach the model), calls spec's injected fault→reprompt builder, and
 * re-enters the STILL-ALIVE session via submit(reprompt). The regenerated spec flows back through the
 * session's live spec sink. spec owns the wording; agent-core owns the redaction + the ingress. The one
 * session stays alive for the host-session lifetime, so this is a re-entry, not a fresh session.
 */
export function routeRuntimeFault(
  fault: RuntimeFault,
  session: RepairIngress,
  buildRepair: RuntimeRepairBuilder,
  policy?: RedactionPolicy,
): AsyncGenerator<MinituiEvent> {
  const redactedFault: RuntimeFault = {
    ...fault,
    stderrExcerpt: redact(fault.stderrExcerpt, policy),
  };
  return session.submit(buildRepair(redactedFault));
}
