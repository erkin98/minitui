/** One controller threads model + tools so Esc kills both. */
export function createAbort(parent?: AbortSignal): {
  controller: AbortController;
  signal: AbortSignal;
} {
  const controller = new AbortController();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return { controller, signal: controller.signal };
}
