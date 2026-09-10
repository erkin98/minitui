// The ONLY json-render built-in actions allowed to bypass the permission gate.
// State mutation is local + instant; everything else (log/exit/...) must be rejected
// so raw console output can't bypass the sanitizer and the process can't be killed.
export const RENDER_LOCAL_ALLOWLIST: ReadonlySet<string> = new Set([
  'setState',
  'pushState',
  'removeState',
]);

export function isRenderLocalAllowed(actionName: string): boolean {
  return RENDER_LOCAL_ALLOWLIST.has(actionName);
}
