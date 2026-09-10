// Maps sandbox denial signals to a structured, host-resolved SandboxViolation. Two inputs:
// lines from the OS sandbox violation store (the descriptive macOS deny records) and raw spawn
// errors (the Linux bubblewrap fallback, where a denial surfaces only as EPERM/EACCES). Pure —
// no runtime dependency on the sandbox runtime; the store lookup lives in the manager.

export interface SandboxViolation {
  readonly kind: 'fs-write' | 'fs-read' | 'egress' | 'unknown';
  readonly reason: string;
  readonly path?: string | undefined;
}

const DENY_LINE = /deny\(\d+\)\s+([a-z-]+)\s+(\S+)/i;

function fromDenyLine(line: string): SandboxViolation | undefined {
  const m = DENY_LINE.exec(line);
  if (!m) return undefined;
  const opRaw = m[1];
  const target = m[2];
  if (opRaw === undefined || target === undefined) return undefined;
  const op = opRaw.toLowerCase();
  if (op.startsWith('network')) {
    return { kind: 'egress', reason: `egress denied: ${op} ${target}` };
  }
  if (op.startsWith('file-write')) {
    return { kind: 'fs-write', reason: `write denied: ${op} ${target}`, path: target };
  }
  if (op.startsWith('file-read')) {
    return { kind: 'fs-read', reason: `read denied: ${op} ${target}`, path: target };
  }
  return { kind: 'unknown', reason: `sandbox denied: ${op} ${target}`, path: target };
}

// Local unknown-to-string (the dependency graph bars importing transport's). Kept `unknown`
// through String() so the base-to-string rule stays quiet; the catch swallows a throwing toString.
function formatUnknown(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}

function errnoCode(err: object): string | undefined {
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Structures a line from the sandbox violation store into a host-resolved violation.
 * Unknown formats degrade to 'unknown' carrying the raw line; never throws.
 */
export function parseViolationLine(line: string): SandboxViolation {
  return fromDenyLine(line) ?? { kind: 'unknown', reason: `sandbox violation: ${line}` };
}

/**
 * Fallback mapper for raw spawn/sandbox errors (prefer the store surface where present).
 * macOS mines the descriptive deny line; Linux EPERM/EACCES default to fs-write (the
 * deny-by-default write surface). Never throws.
 */
export function toSandboxViolation(err: unknown, platform: NodeJS.Platform): SandboxViolation {
  if (typeof err !== 'object' || err === null) {
    return { kind: 'unknown', reason: `sandbox violation: ${formatUnknown(err)}` };
  }
  const message = err instanceof Error ? err.message : formatUnknown(err);

  if (platform === 'darwin') {
    const parsed = fromDenyLine(message);
    if (parsed) return parsed;
  }

  const code = errnoCode(err);
  if (code === 'EPERM' || code === 'EACCES') {
    const path = (err as { path?: unknown }).path;
    return {
      kind: 'fs-write',
      reason: `write denied (${code}): ${message}`,
      ...(typeof path === 'string' ? { path } : {}),
    };
  }

  return { kind: 'unknown', reason: `sandbox violation: ${message}` };
}
