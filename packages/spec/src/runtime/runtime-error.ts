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
 * can drift. The producer sanitises the fault text under the types contract; this
 * package sanitises it again with the same function (`sanitize`, re-exported by
 * `@minitui/catalog`) before it reaches the model, and never implements a strip of
 * its own. The fault stays untrusted by contract.
 */
export type RuntimeError = RuntimeFault;
