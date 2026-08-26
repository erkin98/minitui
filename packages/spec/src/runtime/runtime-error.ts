import type { RuntimeFault } from '@minitui/types';

/**
 * A failed action's outcome routed back for self-correction. The canonical fault
 * shape is owned by `@minitui/types` (`RuntimeFault` = `{ actionKey, exitCode,
 * stderrExcerpt }`);
 * `@minitui/spec` surfaces it under its loop-local name `RuntimeError` by ALIASING
 * the owner rather than restating the three fields, so the fault→envelope→reprompt
 * builder (`toRuntimeRepair`) accepts the exact type every real caller
 * holds — agent-core's `routeRuntimeFault`, the cli `buildRepair` adapter,
 * the integration suite — an EXACT match, never a same-shape twin that
 * can drift. `stderrExcerpt` is already sanitized at the transport seam; this
 * package treats it as plain text and never re-runs the ANSI strip (that impl lives
 * only in `@minitui/sanitizer`).
 */
export type RuntimeError = RuntimeFault;
