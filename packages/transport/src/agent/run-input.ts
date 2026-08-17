import type { RunAgentInput } from '@ag-ui/client';
import type { UserMessage } from '@ag-ui/core';

/**
 * The BFF chokepoint: only userText is untrusted; everything else is host-built.
 * No `as unknown as` escape hatch — the user message is typed as the real AG-UI
 * `UserMessage` ({ id; role: 'user'; content }, source-verified against
 * @ag-ui/core UserMessageSchema), and the object is annotated `RunAgentInput`, so any
 * wrong field/shape fails the compiler instead of compiling silently.
 */
export function buildRunAgentInput(args: {
  threadId: string;
  runId: string;
  userText: string;
  state?: unknown;
}): RunAgentInput {
  const userMessage: UserMessage = {
    id: `${args.runId}-user`,
    role: 'user',
    content: args.userText,
  };
  return {
    threadId: args.threadId,
    runId: args.runId,
    messages: [userMessage],
    tools: [],
    context: [],
    state: args.state ?? {},
    forwardedProps: {},
  };
}
