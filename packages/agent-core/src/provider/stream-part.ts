import type { streamText } from 'ai';
import { redact, type RedactionPolicy } from '../visibility/redaction.js';

/** One part of the model stream as this package reads it: a type tag, and fields checked before use. */
export interface ModelStreamPart {
  readonly type: string;
  readonly [field: string]: unknown;
}

/**
 * The part of the SDK's streamText this package uses: one call, read through its fullStream. The
 * installed streamText satisfies it; a test passes a function of this shape and nothing more.
 */
export type StreamTextFn = (options: Parameters<typeof streamText>[0]) => {
  readonly fullStream: AsyncIterable<ModelStreamPart>;
};

/**
 * A model stream part with its fields read and checked. A tool error carries its text already redacted,
 * next to the raw error value (the loop recognises its own failure class by it).
 */
export type StreamStep =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
    }
  | {
      readonly kind: 'tool-result';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly output: unknown;
    }
  | {
      readonly kind: 'tool-error';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly error: unknown;
      readonly message: string;
      readonly denied: boolean;
    }
  | {
      readonly kind: 'approval-request';
      readonly approvalId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
    }
  | {
      readonly kind: 'approval-response';
      readonly approvalId: string;
      readonly toolCallId: string;
      readonly approved: boolean;
    }
  | {
      readonly kind: 'finish';
      readonly finishReason: unknown;
      readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | undefined;
    }
  | { readonly kind: 'error'; readonly error: unknown };

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

// A field of a value the stream supplies, read without assuming the value is an object.
function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null && name in value
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

const count = (v: unknown): number => (typeof v === 'number' ? v : 0);

/**
 * The one reading of a model stream part, used by the SDK-driven loop and by the SDK provider. A part
 * this package does not read gives undefined. The text of a tool error is redacted here, so neither
 * caller can forward it raw.
 */
export function readStreamPart(
  part: ModelStreamPart,
  policy: RedactionPolicy | undefined,
): StreamStep | undefined {
  switch (part.type) {
    case 'text-delta':
      // The payload is `.text`; only the unrelated 'tool-input-delta' part carries `.delta`.
      return { kind: 'text', text: text(part.text) };
    case 'tool-call':
      return {
        kind: 'tool-call',
        toolCallId: text(part.toolCallId),
        toolName: text(part.toolName),
        input: part.input,
      };
    case 'tool-result':
      return {
        kind: 'tool-result',
        toolCallId: text(part.toolCallId),
        toolName: text(part.toolName),
        output: part.output,
      };
    case 'tool-error':
      return {
        kind: 'tool-error',
        toolCallId: text(part.toolCallId),
        toolName: text(part.toolName),
        error: part.error,
        message: redact(
          part.error instanceof Error ? part.error.message : String(part.error),
          policy,
        ),
        denied: field(part.error, 'denied') === true,
      };
    case 'tool-approval-request':
    case 'tool-approval-response': {
      // Not produced by the installed SDK; read so a later version's parts are not silently dropped.
      const call = part.toolCall;
      const approvalId = text(part.approvalId);
      const toolCallId = text(field(call, 'toolCallId'));
      return part.type === 'tool-approval-request'
        ? {
            kind: 'approval-request',
            approvalId,
            toolCallId,
            toolName: text(field(call, 'toolName')),
            input: field(call, 'input'),
          }
        : { kind: 'approval-response', approvalId, toolCallId, approved: Boolean(part.approved) };
    }
    case 'finish': {
      const usage = part.totalUsage;
      return {
        kind: 'finish',
        finishReason: part.finishReason,
        usage:
          typeof usage === 'object' && usage !== null
            ? {
                inputTokens: count(field(usage, 'inputTokens')),
                outputTokens: count(field(usage, 'outputTokens')),
              }
            : undefined,
      };
    }
    case 'error':
      return { kind: 'error', error: part.error };
    default:
      return undefined;
  }
}
