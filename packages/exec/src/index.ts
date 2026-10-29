// @minitui/exec public barrel. Permission-engine exports live in permission/index.ts;
// the runner, the capability probe, the request builder and the router are the public way to run an action.
export {
  createPermissionEngine,
  parseShellCommand,
  checkHardFloor,
  ensureParserReady,
  checkPathRules,
} from './permission/index.js';
// PermissionEngine is exec-owned; re-exported from the root barrel so a sibling package can name
// the concrete return type of createPermissionEngine. PathRule (the write-path gate type) + the
// type re-export use `export type` (NodeNext verbatimModuleSyntax).
export type { PathRule, PermissionEngine } from './permission/index.js';

// --- sandbox (appended) ---
export { createSandboxManager } from './sandbox/index.js';
export { SandboxUnavailableError } from './errors.js';
export type {
  SandboxManagerHandle,
  SandboxProbe,
  SandboxPolicy,
  WrappedArgv,
  SandboxViolation,
} from './sandbox/index.js';

// --- runner, ffmpeg planner, capability probe ---
export {
  createLocalRunner,
  createCapabilityProvider,
  buildFfmpegRun,
  parseFfmpegProgress,
  makeFfmpegProgressParser,
} from './exec/index.js';
export type { RunnerEvent, RunSpec, MergeSpec, RunnerDeps, LocalRunner } from './exec/index.js';
export type { CapabilityProvider } from './exec/capabilities.js';

// --- sanitize: only the one-string alias is public; consumers import the rest from the sanitiser ---
export { sanitizeUntrusted } from './sanitize/index.js';

// --- the host-resolved request builder: the composition root injects it into the router's deps ---
export { buildPermissionRequest } from './permission/resolve-request.js';

// --- the router: the one public way to run an action; the per-kind handlers stay internal ---
export { createActionRouter } from './dispatch/index.js';
export type { ActionRouterDeps, ExecLocalDeps, CallbackDeps } from './dispatch/index.js';
