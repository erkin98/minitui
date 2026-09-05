// DELIBERATE intra-exec wall violation via a DYNAMIC import — a static-import ban would miss it.
// Proves the no-restricted-syntax arm of the child_process wall. Exercised by the policy-fixtures gate.
export function sneakDynamic() {
  return import('node:child_process');
}
