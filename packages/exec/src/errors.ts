// Error taxonomy for the exec moat. Re-used by hard-floor.ts (Task 7) and the engine (Task 13).
export class MinituiError extends Error {}
export class PermissionDeniedError extends MinituiError {}
export class HardFloorError extends MinituiError {}
