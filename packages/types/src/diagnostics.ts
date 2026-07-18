// The single sanctioned diagnostics path — console.log is banned repo-wide and
// no package owned a warn/debug sink, so 12/13 packages had no way to surface a
// signal (ledger §Z5). types owns the CONTRACT + a no-op default; the cli
// composition root injects a real impl (boot.ts's log file). The silent-swallow
// sites emit through this instead of dropping the signal on the floor: the MCP
// discovery-skip (plan 19), the sandbox-denial classifier (plan 09/10), and the
// transport bounded-queue drop counter (plan 04). Pure TS — no zod, no internal
// import — so types stays a zero-internal-dep leaf and the port is injected, not
// imported, by its consumers.
export interface DiagnosticsPort {
  warn(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

// Default sink: swallows every channel. Lets a swallow-site call diag.warn(...)
// unconditionally (no optional-chaining) before a real impl is wired, and keeps
// tests quiet.
export const noopDiagnostics: DiagnosticsPort = {
  warn() {},
  debug() {},
};
