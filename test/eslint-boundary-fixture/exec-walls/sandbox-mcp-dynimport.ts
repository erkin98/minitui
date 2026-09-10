// DELIBERATE violation: the OS-sandbox dir tries to reach the MCP client through a dynamic import. The
// re-permit allows ONLY the sandbox runtime's exact root, so the MCP client stays capability-walled —
// proving the re-permit did not widen the moat. Exercised by the policy-fixtures gate.
export function sneak() {
  return import('@modelcontextprotocol/client');
}
