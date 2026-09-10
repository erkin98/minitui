import { describe, expect, it } from 'vitest';

import { HardFloorError, MinituiError, PermissionDeniedError } from '../src/errors.js';

// Scaffold smoke test: proves the package resolves and its error taxonomy is wired (Task 0's stated
// proof). The permission/sandbox/runner suites arrive with their own tasks; this keeps the fresh
// package's test and type-check gates non-empty — vitest and tsconfig.test.json each need at least
// one input, and a package that reds `pnpm test`/`typecheck` at scaffold is not independently green.
describe('@minitui/exec scaffold', () => {
  it('exports the error taxonomy rooted at MinituiError', () => {
    expect(new PermissionDeniedError('denied')).toBeInstanceOf(MinituiError);
    expect(new HardFloorError('floored')).toBeInstanceOf(MinituiError);
    expect(new MinituiError('base')).toBeInstanceOf(Error);
  });
});
