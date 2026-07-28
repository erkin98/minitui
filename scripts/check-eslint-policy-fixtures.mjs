/* global console, process */
import { ESLint } from 'eslint';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const expectedByFile = new Map([
  ['test/eslint-boundary-fixture/illegal-import.ts', ['import/no-restricted-paths']],
  [
    'test/eslint-boundary-fixture/illegal-dynamic-capability.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-nonliteral-load.ts',
    ['minitui/no-restricted-capability-load', 'minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-create-require-capability.ts',
    ['minitui/no-restricted-capability-load', 'minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-get-builtin-module.ts',
    ['minitui/no-restricted-capability-load', 'minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-module-export-capability.ts',
    ['minitui/no-restricted-capability-load', 'minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-process-export-capability.ts',
    ['minitui/no-restricted-capability-load', 'minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-computed-process-capability.ts',
    ['minitui/no-restricted-capability-load', 'minitui/no-vitest-replacement-api'],
  ],
  ['test/eslint-boundary-fixture/illegal-eval-capability.ts', ['no-eval']],
  ['test/eslint-boundary-fixture/illegal-implied-eval-capability.ts', ['no-implied-eval']],
  [
    'test/eslint-boundary-fixture/illegal-sanitizer-import.ts',
    ['minitui/sanitizer-local-imports-only'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-alias.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-nonliteral.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-computed.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-string-export.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-create-require.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-get-builtin-module.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-module-export.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-process-export.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-computed-process.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  ['test/eslint-boundary-fixture/illegal-vitest-eval.test.ts', ['no-eval']],
  ['test/eslint-boundary-fixture/illegal-vitest-implied-eval.test.ts', ['no-implied-eval']],
  ['test/eslint-boundary-fixture/illegal-vitest-function-call.test.ts', ['no-restricted-globals']],
  ['test/eslint-boundary-fixture/illegal-vitest-new-function.test.ts', ['no-restricted-globals']],
  ['test/eslint-boundary-fixture/illegal-vitest-function-alias.test.ts', ['no-restricted-globals']],
  [
    'test/eslint-boundary-fixture/illegal-vitest-global-function.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-global-computed-function.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-global-function-destructure.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-global-computed-function-destructure.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-global-function-default.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-global-computed-function-default.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-global-satisfies-function.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-global-as-function-key.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-global-as-function-destructure.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-satisfies-computed-process.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  ['test/eslint-boundary-fixture/legal-vitest-shadowed-global-function.test.ts', []],
  [
    'apps/eslint-policy-fixture/src/illegal-capability.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  ['apps/eslint-policy-fixture/src/illegal-function-alias.ts', ['no-restricted-globals']],
  [
    'apps/eslint-policy-fixture/src/illegal-global-function-alias.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  [
    'apps/eslint-policy-fixture/src/illegal-global-function-destructure.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  [
    'apps/eslint-policy-fixture/src/illegal-global-computed-function-destructure.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  [
    'apps/eslint-policy-fixture/src/illegal-global-function-default.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  [
    'apps/eslint-policy-fixture/src/illegal-global-computed-function-default.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  [
    'apps/eslint-policy-fixture/src/illegal-global-satisfies-function.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  [
    'apps/eslint-policy-fixture/src/illegal-global-as-function-key.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  [
    'apps/eslint-policy-fixture/src/illegal-global-as-function-destructure.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  [
    'apps/eslint-policy-fixture/src/illegal-satisfies-computed-process.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  ['apps/eslint-policy-fixture/src/legal-shadowed-global-function.ts', []],
]);

const eslint = new ESLint({ cwd: root, ignore: false });
const results = await eslint.lintFiles([...expectedByFile.keys()]);
let failed = false;

for (const result of results) {
  const file = relative(root, result.filePath).replaceAll('\\', '/');
  const expected = expectedByFile.get(file) ?? [];
  const actual = result.messages
    .filter((message) => message.severity === 2)
    .map((message) => message.ruleId ?? '<fatal>')
    .sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    console.error(`${file}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
    failed = true;
  }
}

for (const file of expectedByFile.keys()) {
  if (!results.some((result) => relative(root, result.filePath).replaceAll('\\', '/') === file)) {
    console.error(`${file}: fixture was not linted`);
    failed = true;
  }
}

if (failed) process.exitCode = 1;
else console.log('eslint policy fixtures: OK');
