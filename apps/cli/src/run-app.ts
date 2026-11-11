import { randomUUID } from 'node:crypto';
import { sanitize } from '@minitui/sanitizer';
import { toWireSpec, type MiniAppSpec } from '@minitui/spec';
import { buildRunAgentInput } from '@minitui/transport';
import type { CliArgs } from './args.js';
import {
  ProviderRunError,
  composeRegenerationPrompt,
  emptyTextStream,
  specTextOf,
  summarizeEnvelope,
  teeText,
} from './generation.js';
import type { RunAppGraph } from './graph-types.js';
import type { GenerationStatusHandle } from './status-frame.js';

const CANCELLED_EXIT = 130;
const PROVIDER_ERROR_CAP = 2000;

type Generated =
  | { readonly kind: 'spec'; readonly spec: MiniAppSpec }
  | { readonly kind: 'exit'; readonly code: number };

// The text for the person on a failed run: the provider's own words are untrusted, so they are cleaned
// and bounded before they reach the terminal.
function providerErrorLine(err: ProviderRunError): string {
  const summary = `provider error — ${err.message}${err.code ? ` (${err.code})` : ''}`;
  return sanitize(summary, { allow: 'none' }).slice(0, PROVIDER_ERROR_CAP);
}

/**
 * Asks the agent for a spec and validates it, regenerating as the validation asks. Ends in a spec, or in
 * the exit code of a run that produced none: cancelled (130), out of attempts (1) or a provider failure (1).
 */
async function generate(
  args: CliArgs,
  graph: RunAppGraph,
  status: GenerationStatusHandle,
): Promise<Generated> {
  let attempt = 1;
  // The running token total of every finished run; absent until the first report, so the line never
  // reads "0 tokens". It saturates, since the total over many turns can pass 2^53.
  let tokensUsed: number | undefined;
  const reportStatus = (): void => {
    status.update({ attempt, ...(tokensUsed !== undefined ? { tokens: tokensUsed } : {}) });
  };
  const onUsage = (usage: { inputTokens: number; outputTokens: number }): void => {
    tokensUsed = Math.min(
      (tokensUsed ?? 0) + usage.inputTokens + usage.outputTokens,
      Number.MAX_SAFE_INTEGER,
    );
    reportStatus();
  };
  const run = (userText: string): AsyncIterable<string> =>
    teeText(
      specTextOf(
        graph.agentPort.run(
          buildRunAgentInput({ threadId: randomUUID(), runId: randomUUID(), userText }),
        ),
        onUsage,
      ),
      graph.generation,
    );
  graph.generation.intent = args.intent;
  try {
    const result = await graph.validate(run(args.intent), (reprompt) => {
      // Once cancelled, no new turn starts: the validation gets an empty stream and ends.
      if (graph.cancelled()) return emptyTextStream();
      attempt += 1;
      reportStatus();
      return run(
        composeRegenerationPrompt({
          intent: graph.generation.intent,
          previousText: graph.generation.previousText,
          reprompt,
        }),
      );
    });
    if (graph.cancelled()) return { kind: 'exit', code: CANCELLED_EXIT };
    if (result.ok) return { kind: 'spec', spec: result.spec };
    const summary = summarizeEnvelope(result.firstEnvelope, result.lastEnvelope);
    status.unmount();
    graph.diagnostics.warn('could not generate a valid mini app', {
      attempts: result.lastEnvelope.attempt,
      summary,
    });
    graph.stderr.write(`${summary}\n`);
    return { kind: 'exit', code: 1 };
  } catch (err) {
    // A throw caused by the cancel we asked for is a cancel, never reported as an error.
    if (graph.cancelled()) return { kind: 'exit', code: CANCELLED_EXIT };
    if (!(err instanceof ProviderRunError)) throw err;
    status.unmount();
    graph.diagnostics.warn('provider error', { message: err.message, code: err.code });
    graph.stderr.write(`${providerErrorLine(err)}\n`);
    return { kind: 'exit', code: 1 };
  }
}

/**
 * One run of the app: a status line while the spec is generated and validated, then the app itself, held
 * until it ends. The exit code is the outcome's, never a constant, and the caller restores the terminal
 * only after this has returned, so nothing is torn down while the app is still mounted.
 */
export async function runApp(args: CliArgs, graph: RunAppGraph): Promise<number> {
  const status = graph.mountStatus();
  try {
    const generated = await generate(args, graph, status);
    if (generated.kind === 'exit') return generated.code;
    // The session's live sink gets the validated spec in its wire form; the mounted app is fed by the
    // mount below, not by this.
    graph.session.emitSpec(toWireSpec(generated.spec));
    status.unmount();
    const app = await graph.host.mount(generated.spec);
    graph.bindHostSession(app);
    const outcome = await app.done;
    app.dispose();
    return outcome.exitCode;
  } finally {
    graph.bindHostSession(undefined);
    status.unmount();
  }
}
