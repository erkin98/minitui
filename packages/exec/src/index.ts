// @minitui/exec public barrel. Permission-engine exports live in permission/index.ts;
// local-runner/sandbox/dispatch exports are appended as they land.
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
export { SandboxUnavailableError, SandboxViolationError } from './errors.js';
export type {
  SandboxManagerHandle,
  SandboxProbe,
  SandboxPolicy,
  WrappedArgv,
  SandboxViolation,
} from './sandbox/index.js';
