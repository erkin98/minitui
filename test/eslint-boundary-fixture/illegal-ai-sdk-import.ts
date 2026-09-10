// DELIBERATE boundary violation: a non-agent-core file imports the model SDK. Proves the SDK wall
// (only @minitui/agent-core may import `ai`/`@ai-sdk/*`) fires at error level via no-restricted-imports.
// Never built or shipped — the repo-wide lint ignores this directory; the policy-fixtures gate targets it.
import { streamText } from 'ai';

export const planted = streamText;
