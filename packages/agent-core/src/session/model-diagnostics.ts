import type { DiagnosticsPort } from '@minitui/types';
import { redact, type RedactionPolicy } from '../visibility/index.js';
import { toRunError } from '../errors.js';

// One contained call into the diagnostics port. The port is injected by the host and may throw or hand back
// a rejected promise; neither may change a turn's events or become an unhandled rejection. The record is
// built inside the same guard, because building it (redaction, JSON) can throw too.
function report(port: DiagnosticsPort, msg: string, build: () => Record<string, unknown>): void {
  try {
    const returned: unknown = port.warn(msg, build());
    if (returned instanceof Promise) returned.catch(() => {});
  } catch {
    /* a failing diagnostics sink must never reach the turn */
  }
}

/**
 * The handler both streamText call sites pass as `onError`. It reports one record, `{ message }`: the
 * classifier's message after redaction. The raw error never goes into the record — on the installed SDK it
 * carries the request body and the response headers.
 */
export function streamErrorHandler(
  port: DiagnosticsPort,
  policy: RedactionPolicy | undefined,
): (event: { error: unknown }) => void {
  return ({ error }) =>
    report(port, 'model stream error', () => ({
      message: redact(toRunError(error).message, policy),
    }));
}

/**
 * Points the SDK's provider-warning output at the given port. Without this the SDK prints warnings through
 * console.info and console.warn. The switch is process-wide, so with several live turns the last to start
 * receives every warning. Called at the start of every turn and every streamChat call.
 */
export function routeProviderWarnings(port: DiagnosticsPort): void {
  globalThis.AI_SDK_LOG_WARNINGS = (warnings) => {
    for (const warning of warnings) {
      report(port, 'model provider warning', () => ({ warning: JSON.stringify(warning) }));
    }
  };
}
