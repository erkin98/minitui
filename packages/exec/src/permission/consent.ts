import type { PermissionRequest } from '@minitui/types';

// What the approval box can show whole. A request over any bound is denied by the engine before it is
// parsed, in every approval mode; the request builder is in the same package and builds to the same
// numbers, importing this module by relative path. Lengths are JavaScript string lengths. The module is
// package-internal: the package barrel does not export it.
export const CONSENT_SIZE_BUDGET = { commandChars: 4096, paths: 32, pathChars: 1024 } as const;

// The fixed reason for a request over the budget. It never holds any of the request.
export const REQUEST_TOO_LARGE_REASON = 'request too large to show for approval';

export function exceedsConsentBudget(
  req: Pick<PermissionRequest, 'resolvedCommand' | 'resolvedPaths'>,
): boolean {
  return (
    req.resolvedCommand.length > CONSENT_SIZE_BUDGET.commandChars ||
    req.resolvedPaths.length > CONSENT_SIZE_BUDGET.paths ||
    req.resolvedPaths.some((p) => p.length > CONSENT_SIZE_BUDGET.pathChars)
  );
}
