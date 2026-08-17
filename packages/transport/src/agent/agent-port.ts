import type { RunAgentInput } from '@ag-ui/client';
import type { AppEvent } from '../events/app-event.js';

export interface RunHandle {
  events: AsyncGenerator<AppEvent>;
  abort(): void;
  readonly signal: AbortSignal;
}

/** Agent-backend swap seam: local (in-process) and remote (HttpAgent) satisfy this identically. */
export interface AgentPort {
  run(input: RunAgentInput): RunHandle;
}
