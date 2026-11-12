import { NoOutputGeneratedError, type streamText, type TextStreamPart, type ToolSet } from 'ai';
import { redact, type RedactionPolicy } from '../visibility/redaction.js';

/** One part of the model stream as this package reads it: a type tag, and fields checked before use. */
export interface ModelStreamPart {
  readonly type: string;
  readonly [field: string]: unknown;
}

/**
 * The part of the SDK's streamText this package uses: one call, read through its stream. The
 * installed streamText satisfies it; a test passes a function of this shape and nothing more.
 */
export type StreamTextFn = (options: Parameters<typeof streamText>[0]) => {
  readonly stream: AsyncIterable<ModelStreamPart>;
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
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'step'; readonly modelId: string };

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

// A field of a value the stream supplies, read without assuming the value is an object.
function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null && name in value
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

const count = (v: unknown): number => (typeof v === 'number' ? v : 0);

// One reader per part type this package reads. A part's fields are checked before use.
type Reader = (
  part: ModelStreamPart,
  policy: RedactionPolicy | undefined,
) => StreamStep | undefined;
type SdkPartType = TextStreamPart<ToolSet>['type'];

function readApproval(part: ModelStreamPart): StreamStep {
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

const READERS = {
  // The payload is `.text`; only the unrelated 'tool-input-delta' part carries `.delta`.
  'text-delta': (part) => ({ kind: 'text', text: text(part.text) }),
  'tool-call': (part) => ({
    kind: 'tool-call',
    toolCallId: text(part.toolCallId),
    toolName: text(part.toolName),
    input: part.input,
  }),
  'tool-result': (part) => ({
    kind: 'tool-result',
    toolCallId: text(part.toolCallId),
    toolName: text(part.toolName),
    output: part.output,
  }),
  'tool-error': (part, policy) => ({
    kind: 'tool-error',
    toolCallId: text(part.toolCallId),
    toolName: text(part.toolName),
    error: part.error,
    message: redact(part.error instanceof Error ? part.error.message : String(part.error), policy),
    denied: field(part.error, 'denied') === true,
  }),
  // One model call ended: the model id its response named, for the per-step record.
  'finish-step': (part) => ({ kind: 'step', modelId: text(field(part.response, 'modelId')) }),
  'tool-approval-request': readApproval,
  'tool-approval-response': readApproval,
  finish: (part) => {
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
  },
  // The SDK reports a model stream that closed with no output and no finish as this error part. It is read
  // as nothing, so the stream counts as closed without a finish: the retriable drop it is.
  error: (part) =>
    NoOutputGeneratedError.isInstance(part.error)
      ? undefined
      : { kind: 'error', error: part.error },
} satisfies { readonly [type in SdkPartType]?: Reader };

/** The part types this package reads. */
export type HandledPartType = keyof typeof READERS;

/** Every other part type of the installed SDK, each with the reason it is not read. */
export const IGNORED_PARTS = {
  'start-step': 'one model call began; nothing to show',
  start: 'the run began; the session has already said so',
  abort: 'the turn was cancelled; the loop already stops on its own signal',
  'text-start': 'a text block opened; its text arrives as text-delta',
  'text-end': 'a text block closed; its text arrived as text-delta',
  'reasoning-start': 'reasoning is not shown',
  'reasoning-delta': 'reasoning is not shown',
  'reasoning-end': 'reasoning is not shown',
  'reasoning-file': 'reasoning is not shown',
  'tool-input-start': 'the input arrives whole on tool-call',
  'tool-input-delta': 'the input arrives whole on tool-call',
  'tool-input-end': 'the input arrives whole on tool-call',
  'tool-output-denied': 'an approval this package never asks for',
  source: 'citations are not shown',
  file: 'generated files are not read',
  raw: 'raw chunks are never requested',
  custom: 'no provider extension is read',
} as const satisfies { readonly [type in SdkPartType]?: string };

/** The part types this package deliberately does not read. */
export type IgnoredPartType = keyof typeof IGNORED_PARTS;

/**
 * True when every part type of the installed SDK is read or deliberately ignored; otherwise the part types
 * left over, so a part type a new SDK version adds fails to compile until it is placed in one of the two.
 */
export type PartTypesCovered<Handled extends string, Ignored extends string> = [
  Exclude<SdkPartType, Handled | Ignored>,
] extends [never]
  ? true
  : Exclude<SdkPartType, Handled | Ignored>;

export const STREAM_PARTS_COVERED: PartTypesCovered<HandledPartType, IgnoredPartType> = true;

const isHandled = (type: string): type is HandledPartType => Object.hasOwn(READERS, type);

/**
 * The one reading of a model stream part, used by the SDK-driven loop and by the SDK provider. A part
 * this package does not read gives undefined. The text of a tool error is redacted here, so neither
 * caller can forward it raw.
 */
export function readStreamPart(
  part: ModelStreamPart,
  policy: RedactionPolicy | undefined,
): StreamStep | undefined {
  return isHandled(part.type) ? READERS[part.type](part, policy) : undefined;
}
