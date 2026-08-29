import { streamText as realStreamText, type LanguageModel, type ModelMessage } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { ModelProvider } from './provider-port.js';
import type { ProviderChunk, ProviderRequest } from './provider-types.js';
import type { FinishReason } from '../session/finish-reason.js';

type StreamTextFn = typeof realStreamText;

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
 * Classify an SDK error into the ProviderChunk error taxonomy: a context-window overflow is fatal
 * (retriable:false — re-feeding the same too-long history loops forever); everything else is retriable
 * and carries a parsed retry-after when the provider supplied one. Surfaced in-band so the seam has one
 * uniform error shape.
 */
function classifyStreamError(err: unknown): Extract<ProviderChunk, { type: 'error' }> {
  const message = err instanceof Error ? err.message : String(err);
  if (/context|too\s*long|maximum.*token|overflow/i.test(message)) {
    return { type: 'error', message, retriable: false };
  }
  const retryAfterMs = parseRetryAfterMs(message);
  return retryAfterMs === undefined
    ? { type: 'error', message, retriable: true }
    : { type: 'error', message, retriable: true, retryAfterMs };
}

/** Pull the tool call out of an SDK tool-approval part ({ toolCall: { toolCallId, toolName, input } }). */
function approvalToolCall(part: Record<string, unknown>): {
  toolCallId: string;
  toolName: string;
  input: unknown;
} {
  const call = (part.toolCall ?? {}) as {
    toolCallId?: unknown;
    toolName?: unknown;
    input?: unknown;
  };
  return {
    toolCallId: typeof call.toolCallId === 'string' ? call.toolCallId : '',
    toolName: typeof call.toolName === 'string' ? call.toolName : '',
    input: call.input,
  };
}

/**
 * The day-1 ModelProvider: wraps the Vercel AI SDK streamText().fullStream and maps each stream part
 * into the minitui-owned ProviderChunk. This file is the only place SDK stream-part types are read.
 */
export function createAiSdkProvider(
  opts: { apiKey?: string; streamTextImpl?: StreamTextFn } = {},
): ModelProvider {
  const streamText = opts.streamTextImpl ?? realStreamText;
  const anthropic = createAnthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});

  return {
    id: 'anthropic',
    // Drives the SDK streamText tool loop — the session routes it through the SDK path, not the
    // direct-stream path. A scripted / non-SDK provider leaves this unset.
    usesSdkLoop: true,
    // eslint-disable-next-line complexity -- exhaustive closed-union switch over the SDK stream-part arms
    async *streamChat(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk> {
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
      });

      for await (const part of result.fullStream as AsyncIterable<{
        type: string;
        [k: string]: unknown;
      }>) {
        if (signal.aborted) return;
        switch (part.type) {
          case 'text-delta':
            // The payload is `.text`; only the unrelated 'tool-input-delta' part carries `.delta`.
            yield { type: 'text', text: typeof part.text === 'string' ? part.text : '' };
            break;
          case 'tool-call':
            yield {
              type: 'tool-call',
              toolCallId: String(part.toolCallId),
              toolName: String(part.toolName),
              input: part.input,
            };
            break;
          case 'tool-result':
            // The SDK emits tool-result only for a successful execute — failures arrive as 'tool-error'.
            yield {
              type: 'tool-result',
              toolCallId: String(part.toolCallId),
              toolName: String(part.toolName),
              output: part.output,
              isError: false,
            };
            break;
          case 'tool-error':
            // A thrown tool execute — preserve the failure as an isError tool-result chunk; dropping it
            // would silence every tool failure.
            yield {
              type: 'tool-result',
              toolCallId: String(part.toolCallId),
              toolName: String(part.toolName),
              output: part.error,
              isError: true,
            };
            break;
          case 'tool-approval-request': {
            // Forward-compatible: absent in the pinned SDK version, tolerated if a future pin adds it.
            const call = approvalToolCall(part);
            yield {
              type: 'approval-request',
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              input: call.input,
            };
            break;
          }
          case 'tool-approval-response': {
            const call = approvalToolCall(part);
            yield {
              type: 'approval-response',
              toolCallId: call.toolCallId,
              approved: Boolean(part.approved),
            };
            break;
          }
          case 'finish': {
            // The SDK's totalUsage fields are individually optional even when present — coerce to 0 so
            // minitui's usage shape (both fields required) stays sound.
            const totalUsage = part.totalUsage as
              | { inputTokens?: number; outputTokens?: number }
              | undefined;
            yield {
              type: 'finish',
              reason: toFinishReason(part.finishReason),
              ...(totalUsage !== undefined
                ? {
                    usage: {
                      inputTokens: totalUsage.inputTokens ?? 0,
                      outputTokens: totalUsage.outputTokens ?? 0,
                    },
                  }
                : {}),
            };
            break;
          }
          case 'error':
            // Surface the classified error in-band (fatal vs retriable + retry-after) and end the stream,
            // rather than throwing — the seam then has one uniform error shape.
            yield classifyStreamError(part.error);
            return;
          default:
            break;
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
