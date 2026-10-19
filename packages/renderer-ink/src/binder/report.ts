import type { DiagnosticsPort } from '@minitui/types';
import { errorText } from './bound-text.js';

// Report a contained failure to the diagnostics sink. `msg` is a fixed phrase written at the call
// site; the text derived from the error travels in `meta`, sanitised and cut. The call itself is
// contained: a sink that throws, and a sink that returns a rejected promise, change nothing.
export function reportFault(
  diagnostics: DiagnosticsPort | undefined,
  msg: string,
  error: unknown,
  extra: Record<string, unknown> = {},
): void {
  if (diagnostics === undefined) return;
  try {
    const result: unknown = diagnostics.warn(msg, { ...extra, error: errorText(error) });
    void Promise.resolve(result).catch(() => undefined);
  } catch {
    // the sink failed; there is nowhere left to report that
  }
}
