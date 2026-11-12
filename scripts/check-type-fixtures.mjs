/* global console, process */
// Compiles each type fixture on its own and checks that it fails exactly where it says it must. A fixture
// marks the line that must not compile with a `// expect-error: <why>` comment right above it; the check
// passes only when the compiler reports exactly one error, of the named code, on that line. A fixture that
// compiles cleanly fails the check, so the check cannot pass on a wall that is not there.
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// [fixture, tsconfig whose options it is compiled with, the one error code it must report]
const FIXTURES = [
  [
    'packages/agent-core/type-fixtures/string-model.ts',
    'packages/agent-core/tsconfig.test.json',
    2322,
  ],
  [
    'packages/agent-core/type-fixtures/unread-part-type.ts',
    'packages/agent-core/tsconfig.test.json',
    2322,
  ],
];

// The tsconfig's full options, extends chain included (so skipLibCheck and the strict flags hold), with
// the fixture as the only root file.
function optionsOf(tsconfigPath) {
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  return ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfigPath)).options;
}

const MARKER = '// expect-error:';

function checkFixture(file, tsconfig, code) {
  const fixture = join(root, file);
  const lines = readFileSync(fixture, 'utf8').split('\n');
  const markers = lines.flatMap((text, i) => (text.trim().startsWith(MARKER) ? [i + 1] : []));
  if (markers.length !== 1)
    return [`${file}: needs exactly one "${MARKER}" line, has ${markers.length}`];
  const expectedLine = markers[0] + 1;
  const program = ts.createProgram([fixture], optionsOf(join(root, tsconfig)));
  const found = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file !== undefined && d.file.fileName === fixture)
    .map((d) => {
      const { line } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
      return {
        line: line + 1,
        code: d.code,
        text: ts.flattenDiagnosticMessageText(d.messageText, ' '),
      };
    });
  const ok = found.length === 1 && found[0].code === code && found[0].line === expectedLine;
  if (ok) return [];
  const seen = found.map((d) => `  line ${d.line} TS${d.code}: ${d.text.slice(0, 200)}`).join('\n');
  return [
    `${relative(root, fixture)}: want exactly one TS${code} on line ${expectedLine}, got ${found.length}${found.length ? `:\n${seen}` : ''}`,
  ];
}

let failed = false;
for (const [file, tsconfig, code] of FIXTURES) {
  for (const problem of checkFixture(file, tsconfig, code)) {
    console.error(problem);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(
  `type fixtures: OK (${FIXTURES.length} fixture${FIXTURES.length === 1 ? '' : 's'}, each fails where it says)`,
);
