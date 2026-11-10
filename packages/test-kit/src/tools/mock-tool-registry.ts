import type { ActionKind } from '@minitui/types';

export interface ToolOutcome {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly kind: ActionKind;
}

export type ToolLifecycleEvent =
  | { readonly phase: 'started' }
  | { readonly phase: 'progress'; readonly progress: number; readonly message?: string }
  | { readonly phase: 'result'; readonly outcome: ToolOutcome }
  | { readonly phase: 'error'; readonly outcome: ToolOutcome };

export interface ScriptedTool {
  readonly kind: ActionKind;
  readonly lifecycle: readonly ToolLifecycleEvent[];
}

// The lifecycle as a real async stream. It has nothing to wait for between events, but its consumers
// read it with for await, as they read a real run.
// eslint-disable-next-line @typescript-eslint/require-await -- an async generator with no await inside
async function* replay(
  tool: ScriptedTool,
  signal: AbortSignal | undefined,
): AsyncGenerator<ToolLifecycleEvent> {
  for (const ev of tool.lifecycle) {
    if (signal?.aborted === true) return;
    yield ev;
  }
}

/** Scripted tools by name, each replaying a fixed lifecycle; registering returns a new registry. */
export class MockToolRegistry {
  constructor(private readonly tools: Readonly<Record<string, ScriptedTool>> = {}) {}

  has(name: string): boolean {
    return Object.hasOwn(this.tools, name);
  }

  register(name: string, tool: ScriptedTool): MockToolRegistry {
    return new MockToolRegistry({ ...this.tools, [name]: tool });
  }

  /** Throws for an unregistered name before the stream starts, so a caller can assert it directly. */
  run(name: string, _params: unknown, signal?: AbortSignal): AsyncGenerator<ToolLifecycleEvent> {
    const tool = this.has(name) ? this.tools[name] : undefined;
    if (tool === undefined) throw new Error(`MockToolRegistry: unregistered tool: ${name}`);
    return replay(tool, signal);
  }
}

export function createMockToolRegistry(
  tools?: Readonly<Record<string, ScriptedTool>>,
): MockToolRegistry {
  return new MockToolRegistry(tools ?? {});
}
