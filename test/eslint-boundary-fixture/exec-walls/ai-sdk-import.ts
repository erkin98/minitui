// DELIBERATE violation: an exec file imports the model SDK. Proves the exec re-permit block still
// bans `ai`/`@ai-sdk/*` (only agent-core may import them). Exercised by the policy-fixtures gate.
import { streamText } from 'ai';

export const planted = streamText;
