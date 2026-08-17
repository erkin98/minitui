// The single sanctioned diagnostics path. types owns the contract and a no-op
// default; the CLI composition root injects the real sink. Pure TypeScript keeps
// this package a zero-internal-dependency leaf.
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
