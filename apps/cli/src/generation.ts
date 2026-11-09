import type { MinituiEvent } from '@minitui/agent-core';
import { sanitize } from '@minitui/sanitizer';
import type { ValidationEnvelope } from '@minitui/spec';
import type { RunHandle } from '@minitui/transport';

/**
 * The validation loop makes one first pass and five regenerations before it gives up, so the last
 * failing pass is the sixth. A test counts the passes of the real loop, so this cannot drift from it.
 */
export const MAX_GEN_ATTEMPTS = 6;

/** Characters of the previous reply kept in a regeneration prompt (the head). */
export const PREVIOUS_ATTEMPT_CAP = 16_384;

/** A model or provider failure on the run's stream; it ends generation instead of being retried as a spec error. */
export class ProviderRunError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly retriable: boolean,
  ) {
    super(message);
    this.name = 'ProviderRunError';
  }
}

const ISSUE_LINE_CAP = 500;

/**
 * A one-screen summary of a validation that ran out of attempts, for the failure path. The first failure
 * is the cause and the last is shown with it. Every line is cleaned and bounded: the issue text is
 * influenced by the model and is written to a terminal.
 */
export function summarizeEnvelope(first: ValidationEnvelope, last: ValidationEnvelope): string {
  const clip = (line: string): string => sanitize(line, { allow: 'none' }).slice(0, ISSUE_LINE_CAP);
  const linesOf = (label: string, e: ValidationEnvelope): string[] => [
    ...e.structural.map((i) => clip(`  ${label} structural: ${JSON.stringify(i)}`)),
    ...e.catalog.map((i) => clip(`  ${label} catalog: ${JSON.stringify(i)}`)),
    ...e.semantic.map((i) => clip(`  ${label} semantic: ${JSON.stringify(i)}`)),
  ];
  const lines = [...linesOf('first failure', first), ...linesOf('last failure', last)];
  return `minitui: could not generate a valid mini app (exhausted ${last.attempt} attempts)\n${lines.join('\n')}`;
}

/**
 * The patch-line text of the agent's run, read from the normalized event stream. A run-error is thrown
 * and not dropped: by the time it reaches this stream the retries inside the session are spent, so asking
 * again would only meet the same dead provider. The token usage of a finished run is reported on the side.
 */
export async function* specTextOf(
  handle: RunHandle,
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void,
): AsyncIterable<string> {
  for await (const ev of handle.events) {
    if (ev.kind === 'run-error') throw new ProviderRunError(ev.message, ev.code, ev.retriable);
    if (ev.kind === 'text-delta') yield ev.delta;
    if (ev.kind === 'run-finished' && ev.usage !== undefined) onUsage?.(ev.usage);
  }
}

/** The same for a repair turn, read from the session's own events; a RUN_ERROR is thrown as well. */
export async function* repairTextOf(events: AsyncGenerator<MinituiEvent>): AsyncIterable<string> {
  for await (const ev of events) {
    if (ev.type === 'RUN_ERROR') {
      throw new ProviderRunError(ev.message, ev.code, ev.code !== 'non-retriable');
    }
    if (ev.type === 'TEXT_MESSAGE_CONTENT') yield ev.delta;
  }
}

/** The empty stream a cancelled run hands the validation loop so that it ends instead of asking again. */
export function emptyTextStream(): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true as const, value: undefined }),
    }),
  };
}

/**
 * Every regeneration prompt is composed here from the user's intent, the previous reply (capped) and the
 * loop's own reprompt: a turn is stateless, so without them the model would have neither the request nor
 * the reply it was told to fix.
 */
export function composeRegenerationPrompt(args: {
  readonly intent: string;
  readonly previousText: string;
  readonly reprompt: string;
}): string {
  const previous = args.previousText.slice(0, PREVIOUS_ATTEMPT_CAP);
  return [
    'The user asked for this mini app:',
    args.intent,
    '',
    'Your previous reply was:',
    previous === '' ? '(empty)' : previous,
    '',
    args.reprompt,
  ].join('\n');
}

/** What the repair paths need to re-ask with context: the user's intent and the last reply's text. */
export interface GenerationContext {
  intent: string;
  previousText: string;
}

export function createGenerationContext(): GenerationContext {
  return { intent: '', previousText: '' };
}

/** Passes `source` through unchanged and records its text into `into.previousText`, reset at the start. */
export async function* teeText(
  source: AsyncIterable<string>,
  into: GenerationContext,
): AsyncIterable<string> {
  into.previousText = '';
  for await (const chunk of source) {
    if (into.previousText.length < PREVIOUS_ATTEMPT_CAP) into.previousText += chunk;
    yield chunk;
  }
}
