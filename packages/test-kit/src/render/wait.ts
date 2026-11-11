// The same waits as renderer-ink's test support (its focus waits), which no other package can import.

/** Poll a condition, counting attempts: the test clock is frozen, so a deadline read from it never passes. */
export async function until(cond: () => boolean, what: string, attempts = 1000): Promise<void> {
  for (let i = 0; !cond(); i++) {
    if (i >= attempts) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * The condition held on a committed frame; React then runs the passive effects (focus registration, the
 * input subscription) in later immediates, so this also waits two of them.
 */
export async function waitFor(cond: () => boolean, what: string): Promise<void> {
  await until(cond, what);
  await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
}
