// @minitui/exec public barrel. Permission-engine exports are added by this plan's Task 15;
// local-runner/sandbox/dispatch exports are added by later slices.
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
