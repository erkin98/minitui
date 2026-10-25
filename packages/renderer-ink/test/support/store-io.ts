// A real controlled store io over a plain object: getSnapshot, setSnapshot, subscribe. This is the
// shape the transport data store exposes to the renderer.
export function controlledIo(seed: Record<string, unknown> = {}) {
  let snap = seed;
  const subs = new Set<() => void>();
  return {
    getSnapshot: () => snap,
    setSnapshot: (n: Record<string, unknown>) => {
      snap = n;
      subs.forEach((f) => f());
    },
    subscribe: (f: () => void) => {
      subs.add(f);
      return () => {
        subs.delete(f);
      };
    },
  };
}
