import { stepCountIs, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import { assertNever, JsonObjectSchema, type JsonValue } from '@minitui/types';
import type { ToolCallResult, ToolDispatchPort } from '../ports/index.js';
import { routeToolCallResult, redact, type RedactionPolicy } from '../visibility/index.js';
import type { AsyncEventQueue } from '../events/event-stream.js';
import type { MinituiEvent } from '../events/event-types.js';
import type { Conversation } from './conversation.js';
import type { ModelProvider } from '../provider/provider-port.js';
import type { ProviderChunk, ProviderRequest } from '../provider/provider-types.js';
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
import { noopDiagnostics, type DiagnosticsPort } from '@minitui/types';
import { toRunError, ProviderError } from '../errors.js';
import { systemClock, type Clock } from '../ports/index.js';
import { streamErrorHandler } from './model-diagnostics.js';
import { endingOf } from './finish-reason.js';
import { readStreamPart, type StreamTextFn } from '../provider/stream-part.js';

/**
 * Default per-pull idle deadline for the model stream. Sized to exceed a legitimate silent gap (e.g. a
 * long tool exec interleaved by the SDK loop) so it only fires on a genuinely dead stream.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
/** Default mid-stream-drop re-run budget (distinct from stopWhen and the SDK's own maxRetries). */
export const DEFAULT_STREAM_MAX_RETRIES = 2;

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
}

export interface RunTurnsDeps {
  readonly streamTextImpl: StreamTextFn;
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
  /** Output-token ceiling for one model call; forwarded only when defined. */
  readonly maxOutputTokens?: number | undefined;
  /** Waits between re-runs; default systemClock. */
  readonly clock?: Clock | undefined;
  /** Where stream errors are reported; default noopDiagnostics. */
  readonly diagnostics?: DiagnosticsPort | undefined;
}

/** Wait before re-run k (k from 1): 250, 500, 1000, 2000, then 4000 ms. */
const rerunDelayMs = (k: number): number => Math.min(250 * 2 ** (k - 1), 4000);

type ToolResultEvent = Extract<MinituiEvent, { type: 'TOOL_CALL_RESULT' }>;

/**
 * A failed dispatch, thrown from a tool's execute so the SDK reports it to the model as a failure. It
 * carries the observation the dispatch produced, which the stream mapping emits as is: both loops report a
 * failed tool with the same event.
 */
class DispatchFailure extends Error {
  readonly observation: ToolResultEvent;
  constructor(message: string, observation: ToolResultEvent) {
    super(message);
    this.name = 'DispatchFailure';
    this.observation = observation;
  }
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
  // No prototype: a call to `constructor`, `toString` or `__proto__` is an unknown tool like any other.
  const out = Object.create(null) as ToolSet;
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
      execute: async (
        input,
        options: { toolCallId: string; abortSignal?: AbortSignal | undefined },
      ) => {
        // The signal the SDK hands this call (the attempt's signal) wins over the turn signal, so an
        // abandoned attempt's late tool call is not dispatched. Nothing runs once it is aborted.
        const callSignal = options.abortSignal ?? signal;
        if (callSignal.aborted) throw new Error('tool call aborted before dispatch');
        const { toolCallId } = options;
        // ToolDispatchPort takes { toolName, args } and returns { ok, toolName, content, isError,
        // error?, denied? }. The validated input IS the args record.
        let result: ToolCallResult;
        try {
          result = await toolDispatch.dispatch(
            { toolCallId, toolName: s.name, args: input as Readonly<Record<string, JsonValue>> },
            callSignal,
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
        // execution failure. The thrown Error also carries the observation itself (the SDK echoes it
        // verbatim as the tool-error part's `error`), so the stream mapping emits exactly what the other
        // loop emits for the same outcome.
        if (ev.isError) {
          const message = ev.error ?? ev.content;
          throw new DispatchFailure(result.denied ? `Denied: ${message}` : message, ev);
        }
        return ev.content;
      },
    });
  }
  // The synthetic `invalid` tool a repaired (still-unknown) call reroutes to. Its result tells the
  // model what it got wrong so it self-corrects on the next step. Registered so the SDK's re-parse of
  // the repaired call resolves. It is left out of activeTools below, but the model can still name it in a
  // call: calling it dispatches nothing. It is NOT a ToolDispatchPort dispatch — no exec, no gate, so it
  // does NOT cross routeToolCallResult (the payload is the model's own bad tool name + the SDK error
  // text: nothing to redact).
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
// eslint-disable-next-line complexity -- exhaustive closed-union switch over the stream steps (assertNever)
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
  const clock = deps.clock ?? systemClock;
  const onError = streamErrorHandler(deps.diagnostics ?? noopDiagnostics, deps.redactionPolicy);

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
    let finishReason: unknown;
    let finishUsage: { readonly inputTokens: number; readonly outputTokens: number } | undefined;
    // Each attempt has its own controller, combined with the turn signal: it is aborted when the attempt ends,
    // so an abandoned attempt (an idle-timeout re-run) can neither keep streaming nor dispatch a late tool call.
    const attemptController = new AbortController();
    const attemptSignal = AbortSignal.any([signal, attemptController.signal]);

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
          if (lower !== failed.toolCall.toolName && Object.hasOwn(toolSet, lower)) {
            return { ...failed.toolCall, toolName: lower };
          }
          return {
            ...failed.toolCall,
            input: JSON.stringify({ tool: failed.toolCall.toolName, error: failed.error.message }),
            toolName: 'invalid',
          };
        },
        ...(deps.maxOutputTokens !== undefined ? { maxOutputTokens: deps.maxOutputTokens } : {}),
        abortSignal: attemptSignal,
        // Without a handler the SDK prints the error, with the request body and the response headers.
        onError,
      });

      // Race each pull of fullStream against the idle deadline — a silently-stalled stream throws a
      // retriable ProviderError (the whole-turn AbortSignal never fires on a stall). The catch below
      // decides whether the drop is re-run or surfaced.
      const parts = withIdleTimeout(
        result.fullStream,
        idleTimeoutMs,
        () => new ProviderError('idle timeout waiting for model stream', true),
      );
      for await (const part of parts) {
        if (signal.aborted) break;
        const step = readStreamPart(part, deps.redactionPolicy);
        if (step === undefined) continue;
        switch (step.kind) {
          case 'text':
            emittedContent = true;
            await queue.push(textContent(step.text));
            break;
          case 'tool-call':
            // The SDK part field is toolName; the wire event field is toolCallName — mapped here.
            // A dispatched tool may have side effects, so emittedContent bars any re-run past this point.
            emittedContent = true;
            await queue.push(toolCallStart(step.toolCallId, step.toolName));
            break;
          case 'tool-result':
            // On the pinned SDK a tool-result is emitted ONLY for a successful buildTools execute,
            // whose return already crossed routeToolCallResult — but redact here too so the observation
            // is total by CONSTRUCTION, not by that assumption: a future provider-defined / server-side
            // tool could emit a tool-result that never touched execute. Idempotent on redacted text.
            emittedContent = true;
            await queue.push(
              agentObservation({
                toolCallId: step.toolCallId,
                toolName: step.toolName,
                content: redact(
                  typeof step.output === 'string'
                    ? step.output
                    : JSON.stringify(step.output ?? null),
                  deps.redactionPolicy,
                ),
                isError: false,
              }),
            );
            break;
          case 'tool-error':
            // The live failure path (a thrown execute). A failed dispatch carries its own observation (see
            // DispatchFailure), emitted as is. Any other tool error — a rejected dispatch, a bad input, a
            // provider-run tool — surfaces as TOOL_CALL_RESULT isError:true with the text the reader
            // already redacted.
            emittedContent = true;
            await queue.push(
              step.error instanceof DispatchFailure
                ? step.error.observation
                : agentObservation({
                    toolCallId: step.toolCallId,
                    toolName: step.toolName,
                    content: step.message,
                    isError: true,
                    error: step.message,
                    ...(step.denied ? { denied: true } : {}),
                  }),
            );
            break;
          case 'approval-request':
            // Escape hatch onto the CUSTOM event; a non-SDK provider carries the live approval contract.
            emittedContent = true;
            await queue.push(
              custom('tool-approval-request', {
                approvalId: step.approvalId,
                toolCallId: step.toolCallId,
                toolName: step.toolName,
              }),
            );
            break;
          case 'approval-response':
            emittedContent = true;
            await queue.push(
              custom('tool-approval-response', {
                approvalId: step.approvalId,
                toolCallId: step.toolCallId,
                approved: step.approved,
              }),
            );
            break;
          case 'finish':
            // The SDK's terminal marker (always emitted on a clean stream). Its ABSENCE after the loop
            // ends means the stream was truncated.
            sawFinish = true;
            finishReason = step.finishReason;
            finishUsage = step.usage;
            break;
          case 'error': {
            // An explicit in-stream error is already classified + terminal — surface it, never re-run
            // (a drop is a stall/truncation with no error object; that is what the re-run tier retries).
            const { message, retriable } = toRunError(step.error);
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
            return assertNever(step);
        }
      }
      if (signal.aborted) return;
      // fullStream ended without a `finish` part — a truncated stream — or with one whose reason says how
      // the run ends: a failed or dropped generation is raised as a retriable error (the re-run rule below
      // applies), a cut, filtered or halted one ends the run as a non-retriable error.
      const ending = sawFinish ? endingOf(finishReason) : endingOf(undefined);
      if (ending.kind === 'finished') {
        await queue.push(runFinished(threadId, runId, finishUsage));
        return;
      }
      if (ending.retriable) throw new ProviderError(ending.message, true);
      await queue.push(runError(ending.message, 'non-retriable'));
      return;
    } catch (err) {
      if (signal.aborted) return;
      const { message, retriable } = toRunError(err);
      // Re-run a retriable drop that emitted nothing this attempt, within the retry budget. The abandoned
      // attempt ends before the wait, and the wait yields to timers so the turn deadline can end the loop.
      if (retriable && !emittedContent && attempt < streamMaxRetries) {
        attemptController.abort();
        await clock.sleep(rerunDelayMs(attempt + 1), signal);
        if (signal.aborted) return;
        continue;
      }
      await queue.push(
        runError(redact(message, deps.redactionPolicy), retriable ? undefined : 'non-retriable'),
      );
      return;
    } finally {
      attemptController.abort();
    }
  }
}

/**
 * One tool call of the non-SDK loop, dispatched, as its observation. The checks the SDK makes on its own
 * loop run first: the name must be one of the session's tools and the input must parse with that tool's
 * input schema into a JSON object. A refused call is never dispatched. A dispatch that rejects becomes a
 * failed result. The fixed messages name no model-chosen text.
 */
async function dispatchToolCall(
  call: Extract<ProviderChunk, { type: 'tool-call' }>,
  tools: readonly ToolSchema[],
  toolDispatch: ToolDispatchPort,
  policy: RedactionPolicy | undefined,
  signal: AbortSignal,
): Promise<MinituiEvent> {
  const failed = (error: string): MinituiEvent =>
    routeToolCallResult(
      {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        ok: false,
        content: '',
        isError: true,
        error,
      },
      policy,
    );
  const schema = tools.find((t) => t.name === call.toolName);
  if (schema === undefined) {
    const names = tools.map((t) => t.name).join(', ');
    return failed(`unknown tool; valid tools: ${names === '' ? 'none' : names}`);
  }
  const input = schema.inputSchema.safeParse(call.input);
  const args = input.success ? JsonObjectSchema.safeParse(input.data) : undefined;
  if (args === undefined || !args.success) return failed(`invalid input for tool ${schema.name}`);
  try {
    const result = await toolDispatch.dispatch(
      { toolCallId: call.toolCallId, toolName: schema.name, args: args.data },
      signal,
    );
    return routeToolCallResult(result, policy);
  } catch (err) {
    return failed(err instanceof Error ? err.message : 'tool dispatch failed');
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
 * `provider.usesSdkLoop` is not true.
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
  /** The tools the model may call; a call to any other name is refused without a dispatch. */
  tools: readonly ToolSchema[];
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
    tools,
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
          // No SDK tool loop runs here, so THIS is the host's dispatch site. Every outcome crosses
          // routeToolCallResult (the redaction chokepoint), like runTurns.
          const observation = await dispatchToolCall(
            chunk,
            tools,
            toolDispatch,
            redactionPolicy,
            signal,
          );
          if (signal.aborted) return;
          await queue.push(observation);
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
        case 'finish': {
          // The non-SDK path forwards the chunk's own usage (already the optional shape). The reason
          // ends the run as what it was; this loop has no re-run tier, so a failed generation is the
          // retriable RUN_ERROR itself.
          const ending = endingOf(chunk.reason);
          await queue.push(
            ending.kind === 'finished'
              ? runFinished(threadId, runId, chunk.usage)
              : runError(ending.message, ending.retriable ? undefined : 'non-retriable'),
          );
          return;
        }
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
