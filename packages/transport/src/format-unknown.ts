export function formatUnknown(value: unknown, fallback = 'unknown value'): string {
  try {
    if (value instanceof Error) {
      // Single observation: a non-idempotent `message` getter (string on the
      // typeof-check read, non-string on the return read) cannot make this
      // `: string` formatter return a non-string.
      const message = value.message;
      if (typeof message === 'string') return message;
    }
  } catch {
    // Continue through the guarded primitive conversion.
  }
  try {
    return String(value);
  } catch {
    return fallback;
  }
}
