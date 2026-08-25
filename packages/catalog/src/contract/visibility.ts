/**
 * The three-class field-visibility model, pinned as BUILDER-owned catalog metadata
 * the agent CANNOT widen — the a2ui `callableFrom` shape (read at runtime, default
 * clientOnly, MUST-reject on a widen) extended with a `localOnly` class for secrets.
 * The class governs TWO surfaces: (1) state projection to the model — whether a
 * component's bound field VALUE is included in the state snapshot shown to the
 * agent; (2) callback params — whether that value may leave as a remote/agent
 * callback argument. Ordered by exposure (narrowest to widest).
 */
export type VisibilityClass = 'localOnly' | 'clientOnly' | 'remoteOnly';

// Exposure order. The agent may only NARROW, never widen, the builder-declared
// class (a2ui MUST-reject on a widen).
const EXPOSURE: readonly VisibilityClass[] = ['localOnly', 'clientOnly', 'remoteOnly'];

/** a2ui default when a def omits the class. */
export const DEFAULT_VISIBILITY: VisibilityClass = 'clientOnly';

/** The class a secret-typed component is FORCED to — never projected, never remote. */
export const SECRET_VISIBILITY: VisibilityClass = 'localOnly';

/** true when `requested` is strictly WIDER (more exposed) than `declared`. */
export function isWiderThan(requested: VisibilityClass, declared: VisibilityClass): boolean {
  return EXPOSURE.indexOf(requested) > EXPOSURE.indexOf(declared);
}
