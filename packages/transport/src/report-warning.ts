import type { DiagnosticsPort } from '@minitui/types';

// The one way transport reports to a diagnostics sink. Diagnostics is observational: a sink that
// throws, or that returns a promise which later rejects, never breaks the path it observes. The call
// sits in a try, and a returned promise gets a handler so its rejection is never left unhandled. Not
// exported by the package barrel.
export function reportWarning(
  diagnostics: DiagnosticsPort | undefined,
  message: string,
  meta: Record<string, unknown>,
): void {
  try {
    const result: unknown = diagnostics?.warn(message, meta);
    if (result !== undefined) void Promise.resolve(result).catch(() => undefined);
  } catch {
    // contained: the sink cannot break delivery
  }
}
