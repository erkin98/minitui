// Error taxonomy for the exec moat. Re-used by hard-floor.ts and the engine.
export class MinituiError extends Error {}
export class HardFloorError extends MinituiError {}

// OS sandbox error types.
/** Thrown when the sandbox cannot run (unloadable runtime / unsupported OS / missing deps) and a gated action was attempted. Fail-closed. */
export class SandboxUnavailableError extends MinituiError {
  constructor(reason: string, options?: ErrorOptions) {
    super(reason, options);
    this.name = 'SandboxUnavailableError';
  }
}

// Local runner error types.
export class CwdError extends MinituiError {
  override readonly name = 'CwdError';
}

export class BinNotFoundError extends MinituiError {
  override readonly name = 'BinNotFoundError';
}

export class FfmpegSpecError extends MinituiError {
  override readonly name = 'FfmpegSpecError';
}
