import { streamText as realStreamText, type LanguageModel, type ModelMessage } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { ModelProvider } from './provider-port.js';
import type { ProviderChunk, ProviderRequest } from './provider-types.js';
import type { FinishReason } from '../session/finish-reason.js';
import { assertNever, noopDiagnostics, type DiagnosticsPort } from '@minitui/types';
import { toRunError } from '../errors.js';
import { routeProviderWarnings, streamErrorHandler } from '../session/model-diagnostics.js';
import { readStreamPart, type StreamTextFn } from './stream-part.js';
import type { RedactionPolicy } from '../visibility/index.js';

/** Narrow a raw SDK finish reason to minitui's FinishReason union (unknowns fold to 'other'). */
function toFinishReason(raw: unknown): FinishReason {
  const allowed: FinishReason[] = [
    'stop',
    'length',
    'tool-calls',
    'content-filter',
    'error',
    'other',
  ];
  return (allowed as readonly string[]).includes(raw as string) ? (raw as FinishReason) : 'other';
}

/**
 * Pull "try again in N s|ms" out of a rate-limit message. Returns milliseconds, or undefined when the
 * message carries no hint.
 */
function parseRetryAfterMs(message: string): number | undefined {
  const m = /try again in\s*(\d+(?:\.\d+)?)\s*(ms|s|seconds?)/i.exec(message);
  const num = m?.[1];
  const unit = m?.[2];
  if (num === undefined || unit === undefined) return undefined;
  const value = Number.parseFloat(num);
  if (Number.isNaN(value)) return undefined;
  return unit.toLowerCase() === 'ms' ? value : value * 1000;
}

/**
 * Classify an SDK error into the ProviderChunk error taxonomy with the package's one classifier
 * (toRunError): a context-window overflow or a rejected request is fatal (retriable:false), everything
 * else is retriable and carries a parsed retry-after when the provider supplied one. Surfaced in-band so
 * the seam has one uniform error shape.
 */
function classifyStreamError(err: unknown): Extract<ProviderChunk, { type: 'error' }> {
  const { message, retriable } = toRunError(err);
  if (!retriable) return { type: 'error', message, retriable: false };
  const retryAfterMs = parseRetryAfterMs(message);
  return retryAfterMs === undefined
    ? { type: 'error', message, retriable: true }
    : { type: 'error', message, retriable: true, retryAfterMs };
}

/**
 * The day-1 ModelProvider: wraps the Vercel AI SDK streamText().fullStream and maps each stream part
 * into the minitui-owned ProviderChunk. This file is the only place SDK stream-part types are read.
 */
export function createAiSdkProvider(
  opts: {
    apiKey?: string;
    streamTextImpl?: StreamTextFn;
    diagnostics?: DiagnosticsPort;
    redactionPolicy?: RedactionPolicy | undefined;
  } = {},
): ModelProvider {
  const streamText = opts.streamTextImpl ?? realStreamText;
  const diagnostics = opts.diagnostics ?? noopDiagnostics;
  const anthropic = createAnthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});

  return {
    id: 'anthropic',
    // Drives the SDK streamText tool loop — the session routes it through the SDK path, not the
    // direct-stream path. A scripted / non-SDK provider leaves this unset.
    usesSdkLoop: true,
    // eslint-disable-next-line complexity -- exhaustive closed-union switch over the stream steps (assertNever)
    async *streamChat(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk> {
      routeProviderWarnings(diagnostics);
      const result = streamText({
        model: anthropic(req.config.model),
        // `system` is the current SDK option name; a future major renames it — update this one call site
        // on the bump. Optional args use conditional spread: never forward a `T | undefined` where the SDK
        // declares a bare `?: T` (exactOptionalPropertyTypes).
        ...(req.config.system !== undefined ? { system: req.config.system } : {}),
        // ProviderMessage rows are a structural subset of the SDK ModelMessage union; the cast narrows the
        // per-row role/content pair to the union member (the one documented boundary cast).
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })) as ModelMessage[],
        ...(req.config.temperature !== undefined ? { temperature: req.config.temperature } : {}),
        ...(req.config.maxOutputTokens !== undefined
          ? { maxOutputTokens: req.config.maxOutputTokens }
          : {}),
        abortSignal: signal,
        onError: streamErrorHandler(diagnostics, opts.redactionPolicy),
      });

      for await (const part of result.fullStream) {
        if (signal.aborted) return;
        const step = readStreamPart(part, undefined);
        if (step === undefined) continue;
        switch (step.kind) {
          case 'text':
            yield { type: 'text', text: step.text };
            break;
          case 'tool-call':
            yield {
              type: 'tool-call',
              toolCallId: step.toolCallId,
              toolName: step.toolName,
              input: step.input,
            };
            break;
          case 'tool-result':
            yield {
              type: 'tool-result',
              toolCallId: step.toolCallId,
              toolName: step.toolName,
              output: step.output,
              isError: false,
            };
            break;
          case 'tool-error':
            // A failed tool call stays a failure: an isError tool-result chunk with the redacted text on
            // both `output` and the dedicated `error` slot (a raw Error would stringify to '{}').
            yield {
              type: 'tool-result',
              toolCallId: step.toolCallId,
              toolName: step.toolName,
              output: step.message,
              isError: true,
              error: step.message,
            };
            break;
          case 'approval-request':
            yield {
              type: 'approval-request',
              toolCallId: step.toolCallId,
              toolName: step.toolName,
              input: step.input,
            };
            break;
          case 'approval-response':
            yield {
              type: 'approval-response',
              toolCallId: step.toolCallId,
              approved: step.approved,
            };
            break;
          case 'finish':
            yield {
              type: 'finish',
              reason: toFinishReason(step.finishReason),
              ...(step.usage !== undefined ? { usage: step.usage } : {}),
            };
            break;
          case 'error':
            // Surface the classified error in-band (fatal vs retriable + retry-after) and end the stream,
            // rather than throwing — the seam then has one uniform error shape.
            yield classifyStreamError(step.error);
            return;
          default:
            return assertNever(step);
        }
      }
    },
  };
}

/**
 * Build a day-1 Anthropic LanguageModel handle from a model id — a thin createAnthropic({apiKey})(modelId)
 * wrapper. agent-core is the only package allowed to import ai/@ai-sdk/*, so the composition root cannot
 * construct the model handle itself; it imports this and passes the handle to the session. `apiKey` is
 * optional — the SDK reads ANTHROPIC_API_KEY lazily at request time, never at model construction, so this
 * makes no network call and cannot throw on a missing key.
 */
export function createAnthropicModel(
  modelId: string,
  opts: { apiKey?: string } = {},
): LanguageModel {
  return createAnthropic(opts.apiKey ? { apiKey: opts.apiKey } : {})(modelId);
}
