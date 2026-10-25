// LEGAL witness: the OS-sandbox dir loads the sandbox runtime through a DYNAMIC import (the fail-closed
// loading seam — a missing install degrades to a closed probe instead of a module-load crash). The
// capability-load re-permit for this dir allows this EXACT root specifier, so no rule fires. Exercised by
// the policy-fixtures gate.
export function load() {
  return import('@anthropic-ai/sandbox-runtime');
}
