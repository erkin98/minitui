// Compiled by scripts/check-type-fixtures.mjs, never run. The SDK-loop route takes a model object: a model id
// string would reach the SDK's global provider, which defaults to a hosted gateway.
import type { ToolDispatchPort, SpecSinkPort } from '../src/ports/index.js';
import type { VisibilityChannel } from '../src/visibility/index.js';
import { AgentSession } from '../src/session/agent-session.js';
import { createAiSdkProvider } from '../src/provider/ai-sdk-provider.js';

declare const toolDispatch: ToolDispatchPort;
declare const specSink: SpecSinkPort;
declare const visibility: VisibilityChannel;

export const session = new AgentSession({
  // expect-error: a model id string is not a model object on the SDK loop
  route: { provider: createAiSdkProvider(), model: 'test-model' },
  toolDispatch,
  specSink,
  visibility,
  tools: [],
});
