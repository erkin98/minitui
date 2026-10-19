import type { DiagnosticsPort } from '@minitui/types';

// Real DiagnosticsPort implementations that misbehave the two ways a sink can: it throws, or it
// returns a promise that rejects. The port types `warn` as void, which a function returning a
// promise satisfies.
export const throwingSink: DiagnosticsPort = {
  warn(): void {
    throw new Error('diagnostics sink threw');
  },
  debug(): void {},
};

const rejectingWarn: (message: string) => Promise<never> = () =>
  Promise.reject(new Error('diagnostics sink rejected'));

export const rejectingSink: DiagnosticsPort = {
  warn: rejectingWarn,
  debug(): void {},
};

// Runs `run`, lets a few event-loop turns pass, and returns every unhandled rejection seen meanwhile
// through a real process listener.
export async function unhandledRejectionsDuring(
  run: () => void | Promise<void>,
): Promise<unknown[]> {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', listener);
  try {
    await run();
    for (let turn = 0; turn < 3; turn++)
      await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', listener);
  }
  return seen;
}
