import { stepCountIs, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import { assertNever, type JsonValue } from '@minitui/types';
import type { ToolCallResult, ToolDispatchPort } from '../ports/index.js';
import { routeToolCallResult, redact, type RedactionPolicy } from '../visibility/index.js';
import type { AsyncEventQueue } from '../events/event-stream.js';
import type { MinituiEvent } from '../events/event-types.js';
import type { Conversation } from './conversation.js';
import type { ModelProvider } from '../provider/provider-port.js';
import type { ProviderRequest } from '../provider/provider-types.js';
import {
  textContent,
  toolCallStart,
  agentObservation,
  runFinished,
  runError,
  custom,
} from '../events/event-factory.js';
import { repeatedToolCallDetector, DEFAULT_STEP_CEILING } from '../guards/loop-guard.js';
import { withIdleTimeout } from '../guards/timeout.js';
import { toRunError, ProviderError } from '../errors.js';

/**
 * Default per-pull idle deadline for the model stream. Sized to exceed a legitimate silent gap (e.g. a
 * long tool exec interleaved by the SDK loop) so it only fires on a genuinely dead stream.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
/** Default mid-stream-drop re-run budget (distinct from stopWhen and the SDK's own maxRetries). */
export const DEFAULT_STREAM_MAX_RETRIES = 2;

/** Coerce a loosely-typed stream-part field to a string, defaulting a non-string (or absent) one to ''. */
const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
}

export interface RunTurnsDeps {
  readonly streamTextImpl: typeof import('ai').streamText;
  readonly toolDispatch: ToolDispatchPort;
  readonly tools: readonly ToolSchema[];
  readonly stepCeiling?: number;
  /** Per-pull stall deadline for fullStream; default DEFAULT_IDLE_TIMEOUT_MS. */
  readonly idleTimeoutMs?: number | undefined;
  /** Mid-stream-drop re-run budget; default DEFAULT_STREAM_MAX_RETRIES. */
  readonly streamMaxRetries?: number | undefined;
  /** Host redaction policy passed to routeToolCallResult on every dispatch result (extraSecretPatterns). */
  readonly redactionPolicy?: RedactionPolicy | undefined;
  readonly model: LanguageModel;
}

/** Build the SDK tool set: each tool's execute delegates to ToolDispatchPort — the host's exec/gate. */
function buildTools(
  schemas: readonly ToolSchema[],
  toolDispatch: ToolDispatchPort,
  signal: AbortSignal,
  policy?: RedactionPolicy,
): ToolSet {
  // Type the record with the SDK's own ToolSet (= Record<string, Tool>) — never
  // ReturnType<typeof tool>, which resolves the overloaded generic to its LAST overload
  // (Tool<never, never>) and reds a string-returning execute. ToolSet is also the exact type
  // streamText({ tools }) accepts.
  const out: ToolSet = {};
  for (const s of schemas) {
    // `invalid` is reserved for the synthetic repair-reroute tool registered below — a catalog tool
    // of that name would be silently shadowed by it. Reject the collision (the frozen v1 catalog has
    // no such tool).
    if (s.name === 'invalid') {
      throw new Error("tool name 'invalid' is reserved for the repair-reroute tool");
    }
    out[s.name] = tool({
      description: s.description,
      inputSchema: s.inputSchema,
      execute: async (input, { toolCallId }: { toolCallId: string }) => {
        // ToolDispatchPort takes { toolName, args } and returns { ok, toolName, content, isError,
        // error?, denied? }. The validated input IS the args record.
        let result: ToolCallResult;
        try {
          result = await toolDispatch.dispatch(
            { toolCallId, toolName: s.name, args: input as Readonly<Record<string, JsonValue>> },
            signal,
          );
        } catch (err) {
          // A REJECTED dispatch (an unexpected throw, not the modelled ok:false result) still crosses the
          // redaction chokepoint: rethrow a REDACTED Error so the SDK's model re-feed AND the observation
          // carry no raw path/secret. Chokepoint is total: every dispatch OUTCOME — resolved-isError or
          // rejected — is redacted before the provider sees it.
          throw new Error(redact(err instanceof Error ? err.message : String(err), policy));
        }
        // The redaction chokepoint: EVERY dispatch OUTCOME is redacted before the provider sees it — a
        // resolved result crosses routeToolCallResult (which redacts `content` AND `error` and folds
        // ok:false/denied into isError), a rejection crosses the catch above. Raw ToolCallResult strings
        // NEVER reach the SDK re-feed; what the model sees (and what fullStream later echoes as the
        // tool-result/tool-error parts) is the redacted observation.
        const ev = routeToolCallResult(result, policy);
        // routeToolCallResult always yields a TOOL_CALL_RESULT event; the check narrows the union.
        if (ev.type !== 'TOOL_CALL_RESULT') {
          throw new Error('unreachable: observation events are TOOL_CALL_RESULT');
        }
        // A FAILED dispatch must THROW: the SDK catches the throw and emits a 'tool-error' part it
        // re-feeds to the model AS A FAILURE. Returning the content would re-feed the failure as a
        // successful tool-result and drop the isError bit. The thrown message carries the REDACTED
        // error/content and keeps the `denied` distinction — a host permission-gate refusal, not an
        // execution failure — BOTH in the message text AND as a structured bit: attach `denied` to
        // the thrown Error so the fullStream tool-error mapping re-emits it on the observation (the
        // SDK echoes the thrown Error verbatim as the tool-error part's `error`).
        if (ev.isError) {
          const message = ev.error ?? ev.content;
          const failure = new Error(result.denied ? `Denied: ${message}` : message);
          if (result.denied) (failure as { denied?: boolean }).denied = true;
          throw failure;
        }
        return ev.content;
      },
    });
  }
  // The synthetic `invalid` tool a repaired (still-unknown) call reroutes to. Its result tells the
  // model what it got wrong so it self-corrects on the next step. Registered so the SDK's re-parse of
  // the repaired call resolves, but excluded from activeTools below so the model can never call it
  // directly. It is NOT a ToolDispatchPort dispatch — no exec, no gate, so it does NOT cross
  // routeToolCallResult (the payload is the model's own bad tool name + the SDK error text: nothing
  // to redact).
  out.invalid = tool({
    description:
      'Internal: reports a malformed tool call back to the model so it retries correctly.',
    inputSchema: z.object({ tool: z.string(), error: z.string() }),
    execute: ({ tool: attempted, error }) =>
      `Invalid tool call "${attempted}": ${error}. Valid tools: ${schemas
        .map((s) => s.name)
        .join(', ')}. Retry with a valid tool name and arguments.`,
  });
  return out;
}

/**
 * Thin streamText() wrapper. The SDK OWNS the multi-step loop via stopWhen; this never re-feeds.
 * Maps fullStream parts to MinituiEvents pushed into the queue. Terminal errors become RUN_ERROR.
 */
// eslint-disable-next-line complexity -- exhaustive closed-union switch over the model stream-part arms
export async function runTurns(args: {
  conversation: Conversation;
  threadId: string;
  runId: string;
  queue: AsyncEventQueue<MinituiEvent>;
  signal: AbortSignal;
  deps: RunTurnsDeps;
}): Promise<void> {
  const { conversation, threadId, runId, queue, signal, deps } = args;
  const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const streamMaxRetries = deps.streamMaxRetries ?? DEFAULT_STREAM_MAX_RETRIES;

  // Build the tool set ONCE, outside the re-run loop: it does not depend on the attempt. A deterministic
  // config throw here (e.g. a reserved tool name) surfaces immediately as a NON-RETRIABLE RUN_ERROR —
  // never re-run as if it were a transient stream drop. The repair closure also consults it.
  let toolSet: ToolSet;
  try {
    toolSet = buildTools(deps.tools, deps.toolDispatch, signal, deps.redactionPolicy);
  } catch (err) {
    await queue.push(
      runError(redact(toRunError(err).message, deps.redactionPolicy), 'non-retriable'),
    );
    return;
  }

  // The mid-stream-drop re-run tier. Distinct from stopWhen (bounds STEPS in one stream) and the SDK's
  // call-level maxRetries (only retries ESTABLISHING the stream). A retriable drop (idle-timeout /
  // truncation) re-runs streamText from the same history — but only while THIS attempt emitted nothing,
  // so streaming straight to the consumer never duplicates output or re-executes a dispatched tool.
  // Fatal errors (context overflow) are non-retriable and never re-run.
  for (let attempt = 0; ; attempt += 1) {
    let emittedContent = false;
    let sawFinish = false;
    let finishUsage: { inputTokens: number; outputTokens: number } | undefined;

    try {
      const result = deps.streamTextImpl({
        model: deps.model,
        // ProviderMessage rows are a structural subset of the SDK ModelMessage union; the cast narrows
        // the per-row role/content pair to the union member (a boundary cast, not a masking cast).
        messages: conversation.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })) as ModelMessage[],
        tools: toolSet,
        // The model may only call the real catalog tools; the synthetic `invalid` tool is reachable
        // ONLY via the repair reroute below, never as a direct model call.
        activeTools: deps.tools.map((s) => s.name),
        stopWhen: [
          stepCountIs(deps.stepCeiling ?? DEFAULT_STEP_CEILING),
          repeatedToolCallDetector(),
        ],
        // Two-tier tool-call repair. The SDK invokes this only when a tool call fails to parse. Tier 1
        // case-fixes a wrong-CASE name in place when the lowercased name is a registered tool; tier 2
        // reroutes any still-unknown call to the synthetic `invalid` tool so the model learns what went
        // wrong instead of the turn dying. The repaired call is re-parsed against toolSet, so tier 2's
        // target MUST be registered (it is). The SDK's repair type requires a Promise return, so this is
        // async even though its body does no awaiting.
        // eslint-disable-next-line @typescript-eslint/require-await
        experimental_repairToolCall: async (failed) => {
          const lower = failed.toolCall.toolName.toLowerCase();
          if (lower !== failed.toolCall.toolName && toolSet[lower]) {
            return { ...failed.toolCall, toolName: lower };
          }
          return {
            ...failed.toolCall,
            input: JSON.stringify({ tool: failed.toolCall.toolName, error: failed.error.message }),
            toolName: 'invalid',
          };
        },
        abortSignal: signal,
      });

      // Race each pull of fullStream against the idle deadline — a silently-stalled stream throws a
      // retriable ProviderError (the whole-turn AbortSignal never fires on a stall). The catch below
      // decides whether the drop is re-run or surfaced.
      const parts = withIdleTimeout(
        result.fullStream as AsyncIterable<{ type: string; [k: string]: unknown }>,
        idleTimeoutMs,
        () => new ProviderError('idle timeout waiting for model stream', true),
      );
      for await (const part of parts) {
        if (signal.aborted) break;
        switch (part.type) {
          case 'text-delta':
            // The payload is `.text`; only the unrelated 'tool-input-delta' part carries `.delta`.
            emittedContent = true;
            await queue.push(textContent(asString(part.text)));
            break;
          case 'tool-call':
            // The SDK part field is toolName; the wire event field is toolCallName — mapped here.
            // A dispatched tool may have side effects, so emittedContent bars any re-run past this point.
            emittedContent = true;
            await queue.push(toolCallStart(String(part.toolCallId), String(part.toolName)));
            break;
          case 'tool-result':
            // The SDK emits tool-result ONLY for a successful execute; failures arrive as 'tool-error'.
            // The observation carries toolName so the renderer + observation channel see WHICH tool.
            emittedContent = true;
            await queue.push(
              agentObservation({
                toolCallId: String(part.toolCallId),
                toolName: String(part.toolName),
                content:
                  typeof part.output === 'string'
                    ? part.output
                    : JSON.stringify(part.output ?? null),
                isError: false,
              }),
            );
            break;
          case 'tool-error': {
            // The live failure path (a thrown execute, including the isError throw in buildTools above):
            // surface it as TOOL_CALL_RESULT isError:true. Carry toolName + the structured error AND the
            // `denied` bit — buildTools attaches `denied` to the thrown Error, which the SDK echoes
            // verbatim as this part's `error`, so a permission-gate refusal stays distinguishable from an
            // execution failure on the observation (not only in the message text). Redact the error text
            // here too: the SDK has three tool-error producers and only the buildTools execute crosses the
            // redaction chokepoint, so redacting on this arm makes the observation total by construction —
            // idempotent on the already-redacted text a rejected/isError throw carries.
            emittedContent = true;
            const denied = (part.error as { denied?: boolean } | undefined)?.denied === true;
            await queue.push(
              agentObservation({
                toolCallId: String(part.toolCallId),
                toolName: String(part.toolName),
                content: redact(String(part.error), deps.redactionPolicy),
                isError: true,
                error: redact(String(part.error), deps.redactionPolicy),
                ...(denied ? { denied: true } : {}),
              }),
            );
            break;
          }
          case 'tool-approval-request': {
            // Forward-compatible: these SDK approval parts are absent in the pinned version, so this arm
            // never fires on the pin — the loose switch just tolerates it. A non-SDK provider carries the
            // live approval contract via its own chunk stream. Escape hatch onto the CUSTOM event.
            emittedContent = true;
            const call = part.toolCall as { toolCallId?: unknown; toolName?: unknown } | undefined;
            await queue.push(
              custom('tool-approval-request', {
                approvalId: asString(part.approvalId),
                toolCallId: asString(call?.toolCallId),
                toolName: asString(call?.toolName),
              }),
            );
            break;
          }
          case 'tool-approval-response': {
            emittedContent = true;
            const call = part.toolCall as { toolCallId?: unknown } | undefined;
            await queue.push(
              custom('tool-approval-response', {
                approvalId: asString(part.approvalId),
                toolCallId: asString(call?.toolCallId),
                approved: Boolean(part.approved),
              }),
            );
            break;
          }
          case 'finish': {
            // The SDK's terminal marker (always emitted on a clean stream). Its ABSENCE after the loop
            // ends means the stream was truncated.
            sawFinish = true;
            // Capture token usage off the SDK finish part for the RUN_FINISHED event.
            const tu = (part as { totalUsage?: { inputTokens?: number; outputTokens?: number } })
              .totalUsage;
            if (tu !== undefined) {
              finishUsage = {
                inputTokens: tu.inputTokens ?? 0,
                outputTokens: tu.outputTokens ?? 0,
              };
            }
            break;
          }
          case 'error': {
            // An explicit in-stream error is already classified + terminal — surface it, never re-run
            // (a drop is a stall/truncation with no error object; that is what the re-run tier retries).
            const { message, retriable } = toRunError(part.error);
            // A provider error string is consumer-facing (never re-fed to the model) but can echo a
            // secret/path from the request — redact it like every other externally-sourced string.
            await queue.push(
              runError(
                redact(message, deps.redactionPolicy),
                retriable ? undefined : 'non-retriable',
              ),
            );
            return;
          }
          default:
            break;
        }
      }
      if (signal.aborted) return;
      if (sawFinish) {
        await queue.push(runFinished(threadId, runId, finishUsage));
        return;
      }
      // fullStream ended without a `finish` part — a truncated stream.
      throw new ProviderError('stream closed before finish', true);
    } catch (err) {
      if (signal.aborted) return;
      const { message, retriable } = toRunError(err);
      // Re-run a retriable drop that emitted nothing this attempt, within the retry budget.
      if (retriable && !emittedContent && attempt < streamMaxRetries) continue;
      await queue.push(
        runError(redact(message, deps.redactionPolicy), retriable ? undefined : 'non-retriable'),
      );
      return;
    }
  }
}

/**
 * The NON-SDK provider path. When the injected provider is NOT the ai-sdk-provider — it leaves
 * `usesSdkLoop` unset, e.g. a scripted provider — there is NO streamText tool loop to run: the provider
 * yields a flat ProviderChunk stream. This consumes provider.streamChat(req, signal) and maps each chunk
 * to a MinituiEvent — the mirror of runTurns' fullStream mapping. A `tool-call` chunk is the host's
 * dispatch site: with no SDK loop to run the tool, this dispatches it through ToolDispatchPort (crossing
 * the routeToolCallResult redaction chokepoint) and pushes the observation; a pre-composed `tool-result`
 * chunk (a remote provider reporting its OWN result) maps straight through. AgentSession routes here when
 * `provider.usesSdkLoop` is not set AND no `streamTextImpl` override is present.
 */
// eslint-disable-next-line complexity -- exhaustive closed-union switch over the ProviderChunk arms
export async function runProviderStream(args: {
  provider: ModelProvider;
  conversation: Conversation;
  threadId: string;
  runId: string;
  model: LanguageModel;
  system?: string | undefined;
  toolDispatch: ToolDispatchPort;
  redactionPolicy?: RedactionPolicy | undefined;
  queue: AsyncEventQueue<MinituiEvent>;
  signal: AbortSignal;
}): Promise<void> {
  const {
    provider,
    conversation,
    threadId,
    runId,
    model,
    system,
    toolDispatch,
    redactionPolicy,
    queue,
    signal,
  } = args;
  // A real non-SDK provider reads config.model; a scripted double ignores the request entirely. When the
  // model handle is an opaque object (not a bare id string) fall back to the provider id. The system
  // prompt is already the conversation's head row (AgentSession seeds it) — do NOT also thread it via
  // config.system, or a non-SDK provider honoring both channels applies it twice.
  const headIsSystem = conversation.messages[0]?.role === 'system';
  const request: ProviderRequest = {
    messages: conversation.messages,
    config: {
      model: typeof model === 'string' ? model : provider.id,
      ...(system !== undefined && !headIsSystem ? { system } : {}),
    },
  };
  try {
    for await (const chunk of provider.streamChat(request, signal)) {
      if (signal.aborted) return;
      switch (chunk.type) {
        case 'text':
          await queue.push(textContent(chunk.text));
          break;
        case 'tool-call': {
          // The SDK-side field is toolName; the wire event field is toolCallName — mapped here.
          await queue.push(toolCallStart(chunk.toolCallId, chunk.toolName));
          // No SDK tool loop runs here, so THIS is the host's dispatch site — send the scripted
          // tool-call to ToolDispatchPort and push its observation. Every dispatched result crosses
          // routeToolCallResult (the redaction chokepoint), like runTurns.
          const result = await toolDispatch.dispatch(
            {
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              args: chunk.input as Readonly<Record<string, JsonValue>>,
            },
            signal,
          );
          await queue.push(routeToolCallResult(result, redactionPolicy));
          break;
        }
        case 'tool-result':
          // A pre-composed tool-result is remote-composed (the provider ran the tool), so it should carry
          // no locally-dispatched content — but redact it anyway, symmetric with the tool-call arm above,
          // so the redaction invariant holds by construction rather than by assumption. A failed chunk's
          // failure text rides the dedicated `error` slot (not lost inside a JSON-stringified output).
          await queue.push(
            agentObservation({
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              content: redact(
                typeof chunk.output === 'string'
                  ? chunk.output
                  : JSON.stringify(chunk.output ?? null),
                redactionPolicy,
              ),
              isError: chunk.isError,
              ...(chunk.error !== undefined ? { error: redact(chunk.error, redactionPolicy) } : {}),
            }),
          );
          break;
        case 'approval-request':
          // The live approval carrier: a non-SDK provider's approval variant rides the CUSTOM escape
          // hatch (the SDK-path arm above is forward-compat-only).
          await queue.push(
            custom('tool-approval-request', {
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
            }),
          );
          break;
        case 'approval-response':
          await queue.push(
            custom('tool-approval-response', {
              toolCallId: chunk.toolCallId,
              approved: chunk.approved,
            }),
          );
          break;
        case 'finish':
          // The non-SDK path forwards the chunk's own usage (already the optional shape).
          await queue.push(runFinished(threadId, runId, chunk.usage));
          return;
        case 'error':
          await queue.push(
            runError(
              redact(chunk.message, redactionPolicy),
              chunk.retriable ? undefined : 'non-retriable',
            ),
          );
          return;
        default:
          // ProviderChunk is a closed union (all variants handled above) — a future unmodeled variant
          // fails the BUILD instead of being silently dropped here.
          return assertNever(chunk);
      }
    }
    // A scripted stream that ended without an explicit `finish` chunk still terminates the turn cleanly —
    // there is no SDK truncation/re-run semantics on this path (that is runTurns' concern).
    if (!signal.aborted) await queue.push(runFinished(threadId, runId));
  } catch (err) {
    if (signal.aborted) return;
    const { message, retriable } = toRunError(err);
    await queue.push(
      runError(redact(message, redactionPolicy), retriable ? undefined : 'non-retriable'),
    );
  }
}
