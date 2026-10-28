// Error taxonomy for the exec moat. Re-used by hard-floor.ts and the engine.
export class MinituiError extends Error {}
export class PermissionDeniedError extends MinituiError {}
export class HardFloorError extends MinituiError {}

// OS sandbox error types.
import type { SandboxViolation } from './sandbox/violation.js';

/** Thrown when the sandbox cannot run (unloadable runtime / unsupported OS / missing deps) and a gated action was attempted. Fail-closed. */
export class SandboxUnavailableError extends MinituiError {
  constructor(reason: string, options?: ErrorOptions) {
    super(reason, options);
    this.name = 'SandboxUnavailableError';
  }
}

/** Thrown when a sandboxed command hit a sandbox restriction (write/egress denied). */
export class SandboxViolationError extends MinituiError {
  readonly violation: SandboxViolation;
  constructor(violation: SandboxViolation) {
    super(violation.reason);
    this.name = 'SandboxViolationError';
    this.violation = violation;
  }
}
