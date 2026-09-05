// DELIBERATE intra-exec wall violation: a permission/mcp/dispatch-style file imports the
// child_process builtin directly (only exec/ and sandbox/ may spawn). Proves the STATIC arm of the
// child_process wall. Exercised by the policy-fixtures gate.
import { spawn } from 'node:child_process';

export const planted = spawn;
