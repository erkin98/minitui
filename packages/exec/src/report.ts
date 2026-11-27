import type { DiagnosticsPort } from '@minitui/types';

/**
 * Sends one warning to the diagnostics sink and contains it. A sink that throws, a sink that returns a
 * rejected promise or thenable, and a `then` that itself throws all change nothing for the caller. With
 * no sink, it does nothing. Every diagnostics call in exec goes through here.
 */
export function reportSafely(
  sink: DiagnosticsPort | undefined,
  msg: string,
  meta: Record<string, unknown>,
): void {
  if (sink === undefined) return;
  try {
    const result: unknown = sink.warn(msg, meta);
    if ((typeof result === 'object' && result !== null) || typeof result === 'function') {
      const then: unknown = Reflect.get(result, 'then');
      if (typeof then === 'function') Reflect.apply(then, result, [undefined, () => undefined]);
    }
  } catch {
    // the sink failed; there is nowhere left to report that
  }
}
