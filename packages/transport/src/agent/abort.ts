/** One controller threads model + tools so Esc kills both. */
export function createAbort(parent?: AbortSignal): {
  controller: AbortController;
  signal: AbortSignal;
} {
  const controller = new AbortController();
  if (parent) {
    if (parent.aborted) {
      controller.abort(parent.reason);
    } else {
      const forwardAbort = () => controller.abort(parent.reason);
      const detachParent = () => parent.removeEventListener('abort', forwardAbort);
      parent.addEventListener('abort', forwardAbort, { once: true });
      controller.signal.addEventListener('abort', detachParent, { once: true });
    }
  }
  return { controller, signal: controller.signal };
}
