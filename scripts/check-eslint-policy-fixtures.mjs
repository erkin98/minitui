/* global console, process */
import { ESLint } from 'eslint';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { LEAF, isWallRule, witnessRows } from '../config/eslint-witness-rows.js';

const root = resolve(import.meta.dirname, '..');
const expectedByFile = new Map([
  ['test/eslint-boundary-fixture/illegal-import.ts', ['import/no-restricted-paths']],
  // The by-name counterpart of the line above: illegal-import.ts uses a RELATIVE specifier,
  // this one uses `@minitui/sanitizer`. Only this entry fails when the resolver stops
  // reaching package source, which is the state a cold clone is in without the root
  // tsconfig `paths` mapping.
  ['test/eslint-boundary-fixture/illegal-by-name-import.ts', ['import/no-restricted-paths']],
  // Exercises the from './packages' + `except` zone shape all real package zones use — the
  // two entries above prove only bare file-target zones with no except list. The boundaries
  // config re-targets the live spec zone at this fixture; sanitizer sits outside that
  // zone's allowed set, so exactly one restricted-paths error is expected.
  ['test/eslint-boundary-fixture/illegal-package-zone-import.ts', ['import/no-restricted-paths']],
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
  ['test/eslint-boundary-fixture/illegal-test-file-capability.test.ts', ['no-restricted-imports']],
  ['test/eslint-boundary-fixture/illegal-ai-sdk-import.ts', ['no-restricted-imports']],
  ['test/eslint-boundary-fixture/illegal-react-import.ts', ['no-restricted-imports']],
  // A JavaScript extension is inside the same wall: this fixture only reds if .mjs is keyed.
  ['test/eslint-boundary-fixture/illegal-mjs-capability.mjs', ['no-restricted-imports']],
  // The exec import walls: (a) exec keeps the SDK + React/Ink bans, (b) only exec/+sandbox/ may
  // reach child_process (static + dynamic forms). Each fixture fires exactly the rule its block
  // carries; an unregistered fixture would red this completeness gate.
  ['test/eslint-boundary-fixture/exec-walls/react-import.ts', ['no-restricted-imports']],
  ['test/eslint-boundary-fixture/exec-walls/ai-sdk-import.ts', ['no-restricted-imports']],
  ['test/eslint-boundary-fixture/exec-walls/mcp-spawn.ts', ['no-restricted-imports']],
  ['test/eslint-boundary-fixture/exec-walls/mcp-dynimport.ts', ['no-restricted-syntax']],
  // The sandbox capability re-permit: the OS-sandbox dir may dynamically import the sandbox runtime
  // (exact root allowed → no rule), but the MCP client stays capability-walled there. Deleting the
  // `allow` entry in eslint.config.js reds the first of these, so the re-permit is non-vacuous.
  ['test/eslint-boundary-fixture/exec-walls/sandbox-asrt-dynimport.ts', []],
  [
    'test/eslint-boundary-fixture/exec-walls/sandbox-mcp-dynimport.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-sanitizer-import.ts',
    ['minitui/sanitizer-local-imports-only'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-alias.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  // The .mts witness: proves the widened test-file glob reaches an .mts test, so the
  // replacement-API ban covers ESM/CJS test extensions, not only .ts/.tsx.
  [
    'test/eslint-boundary-fixture/illegal-vitest-mock.test.mts',
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
    'test/eslint-boundary-fixture/illegal-vitest-process-destructure.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-computed-process.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  // Test files may not build doubles through the mocker or the scoped vitest packages, whatever name they
  // import; only the coverage provider is tooling.
  [
    'test/eslint-boundary-fixture/illegal-vitest-mocker.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-scoped.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-vitest-scoped-dynamic.test.ts',
    ['minitui/no-vitest-replacement-api'],
  ],
  ['test/eslint-boundary-fixture/legal-vitest-coverage-provider.test.ts', []],
  // The typed test lane, the ts-comment ban and the two cast bans bite in package and app tests.
  [
    'apps/eslint-policy-fixture/test/illegal-floating-promise.test.ts',
    ['@typescript-eslint/no-floating-promises'],
  ],
  [
    'test/eslint-boundary-fixture/illegal-ts-expect-error.test.ts',
    ['@typescript-eslint/ban-ts-comment'],
  ],
  ['test/eslint-boundary-fixture/illegal-cast-never.test.ts', ['no-restricted-syntax']],
  ['test/eslint-boundary-fixture/illegal-cast-through-unknown.test.ts', ['no-restricted-syntax']],
  // A test may import from a scripts directory only the two named pure helpers.
  [
    'test/eslint-boundary-fixture/illegal-test-scripts-import.test.ts',
    ['import/no-restricted-paths'],
  ],
  ['test/eslint-boundary-fixture/legal-test-scripts-import.test.ts', []],
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
  ['test/eslint-boundary-fixture/legal-vitest-domain-get-builtin-module.test.ts', []],
  [
    'apps/eslint-policy-fixture/src/illegal-capability.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  [
    'apps/eslint-policy-fixture/src/illegal-react-family-dynamic.ts',
    ['minitui/no-restricted-capability-load'],
  ],
  [
    'apps/eslint-policy-fixture/src/illegal-sdk-family-dynamic.ts',
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
  [
    'apps/eslint-policy-fixture/src/illegal-process-destructure.ts',
    ['@typescript-eslint/unbound-method', 'minitui/no-restricted-capability-load'],
  ],
  ['apps/eslint-policy-fixture/src/legal-shadowed-global-function.ts', []],
  ['apps/eslint-policy-fixture/src/legal-domain-get-builtin-module.ts', []],
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

// Registry completeness: every .ts under a fixture tree is either mapped above or named
// here as a deliberate non-fixture. Without this pass, a fixture nobody registers is
// simply never linted and this script reports OK while covering less than it appears to.
//
// The fixture trees are DISCOVERED, not hard-coded: any directory under a fixture root
// whose name ends in `-fixture` is one. A hard-coded list of directories silently
// excludes whichever tree a later plan adds — which is the same non-biting-gate defect
// this pass exists to remove, reintroduced one level up.
const FIXTURE_ROOTS = ['apps', 'test'];
const BUILD_OUTPUT = new Set(['dist', 'dist-types', 'node_modules']);
// internal-stub.ts is the import TARGET of illegal-import.ts, not a fixture of its own:
// it plants no violation and has no expected rule ids.
const NON_FIXTURES = new Set(['test/eslint-boundary-fixture/internal-stub.ts']);

const dirsIn = (rel) =>
  readdirSync(join(root, rel), { withFileTypes: true }).filter((e) => e.isDirectory());

const tsFilesUnder = (rel) =>
  readdirSync(join(root, rel), { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory())
      return BUILD_OUTPUT.has(entry.name) ? [] : tsFilesUnder(`${rel}/${entry.name}`);
    return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name) ? [`${rel}/${entry.name}`] : [];
  });

const fixtureDirs = FIXTURE_ROOTS.flatMap((rootDir) =>
  dirsIn(rootDir)
    .filter((entry) => entry.name.endsWith('-fixture'))
    .map((entry) => `${rootDir}/${entry.name}`),
);

// Guard the inventory against being vacuous itself: if discovery finds no tree (a rename,
// a moved root), the loop below would pass by covering nothing.
if (fixtureDirs.length === 0) {
  console.error(
    `no fixture tree discovered under ${FIXTURE_ROOTS.join('/, ')}/ — the completeness pass is covering nothing`,
  );
  failed = true;
}

for (const dir of fixtureDirs) {
  for (const rel of tsFilesUnder(dir)) {
    if (expectedByFile.has(rel) || NON_FIXTURES.has(rel)) continue;
    console.error(
      `${rel}: fixture file is not in the registry (add it, or list it in NON_FIXTURES)`,
    );
    failed = true;
  }
}

// Witness matrix. The rows live in config/eslint-witness-rows.js. Each row is linted as if it were the
// file it names, and only wall rule ids (plus the ids a row asks to keep) are compared, so type-aware
// noise on an unresolvable module is not part of the claim; a fatal message or a rejected lintText is
// always a mismatch. A row collapses the reports to a set of rule ids unless it is counted.

// A rejected lintText (a rule that fails to load, for example) is a mismatch, not a crash.
async function lintWitness({ path, code, keep, counted }) {
  try {
    const [result] = await eslint.lintText(code, { filePath: join(root, path) });
    const errors = result.messages.filter((message) => message.severity === 2);
    const fatal = errors.find((message) => message.fatal || message.ruleId === null);
    if (fatal) return { actual: ['<fatal>'], note: fatal.message.split('\n')[0] };
    const ids = errors
      .map((message) => message.ruleId)
      .filter((id) => isWallRule(id) || keep.includes(id));
    return { actual: (counted ? ids : [...new Set(ids)]).sort() };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { actual: ['<fatal>'], note: `lintText rejected: ${text.split('\n')[0]}` };
  }
}

if (witnessRows.length === 0) {
  console.error('the witness matrix has no rows: it would cover nothing');
  failed = true;
}
const matrixStart = Date.now();
for (const row of witnessRows) {
  const { actual, note } = await lintWitness(row);
  if (JSON.stringify(actual) !== JSON.stringify(row.expected)) {
    console.error(
      `witness ${row.label} [${row.path}]: expected ${JSON.stringify(row.expected)}, got ${JSON.stringify(actual)}${note ? ` (${note})` : ''}`,
    );
    failed = true;
  }
}
const matrixSeconds = ((Date.now() - matrixStart) / 1000).toFixed(1);
console.log(`witness matrix: ${witnessRows.length} rows in ${matrixSeconds} s`);

// The agent-core rule bans the SDK's MCP names one by one, so the list is bound to the installed SDK
// version. Enumerate what the SDK's root declaration file exports (a runtime import shows only the value
// exports): export lists, type-only export lists and direct declarations. Fail on any MCP name the rule
// does not ban. The check refuses to pass vacuously, and its readers are tested on synthetic text below.
const EXPORT_LIST = /export\s*(?:type\s+)?\{([^}]*)\}/g;
const STAR_REEXPORT = /export\s*(?:type\s+)?\*/;
const DIRECT_EXPORT =
  /export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g;

// One export-list item (`A`, `type A`, `A as b`) -> its exported name when the item is an MCP one. The
// whole item is matched, so `createMCPClient as makeClient` is caught on the left of `as`.
function mcpExportName(item) {
  const text = item.trim().replace(/\s+/g, ' ');
  if (!/mcp/i.test(text)) return undefined;
  return text
    .replace(/^type /, '')
    .split(' as ')
    .pop();
}
const exportItemsOf = (declaration) =>
  [...declaration.matchAll(EXPORT_LIST)]
    .flatMap((match) => match[1].split(','))
    .map((item) => item.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
const directNamesOf = (declaration) => [...declaration.matchAll(DIRECT_EXPORT)].map((m) => m[1]);
const mcpNamesOf = (declaration) =>
  new Set(
    [...exportItemsOf(declaration), ...directNamesOf(declaration)]
      .map(mcpExportName)
      .filter(Boolean),
  );
const unbanned = (names, banned) => [...names].filter((name) => !banned.has(name));
// An enumeration that could not have found an MCP name proves nothing: no export list, a star re-export
// (it hides names behind another module) or no MCP name at all.
const coversNothing = (declaration) =>
  exportItemsOf(declaration).length === 0 ||
  STAR_REEXPORT.test(declaration) ||
  mcpNamesOf(declaration).size === 0;
// What an enumeration of `declaration` finds wrong, given the names the agent-core rule bans.
function enumerationProblems(declaration, banned) {
  if (coversNothing(declaration)) {
    return [
      'installed ai declaration has no export list, re-exports a module with a star, or lists no MCP name: the MCP enumeration would cover nothing',
    ];
  }
  return unbanned(mcpNamesOf(declaration), banned).map(
    (name) => `installed ai root exports ${name}, which the agent-core import rule does not ban`,
  );
}

const sdkRequire = createRequire(join(root, 'packages/agent-core/package.json'));
const sdkDeclaration = readFileSync(sdkRequire.resolve('ai').replace(/\.m?js$/, '.d.ts'), 'utf8');
const agentCoreConfig = await eslint.calculateConfigForFile(
  join(root, 'packages/agent-core/src/index.ts'),
);
const sdkPath = agentCoreConfig.rules['no-restricted-imports']?.[1]?.paths?.find(
  (entry) => typeof entry === 'object' && entry.name === 'ai',
);
const bannedSdkNames = new Set(sdkPath?.importNames ?? []);
for (const problem of enumerationProblems(sdkDeclaration, bannedSdkNames)) {
  console.error(problem);
  failed = true;
}

// Self-test of the whole enumeration on synthetic text. The installed SDK names carry `MCP` on both sides
// of `as` and use plain export lists, so only these inputs prove that a hidden alias, a type-only list, a
// direct declaration and a star re-export are still seen. [what, declaration, banned names, problems]
const NOTHING = 'would cover nothing';
const MCP_THING = new Set(['MCPThing']);
const SELF_TESTS = [
  [
    'an alias hiding the name on its right-hand side',
    'export { createMCPClient as makeClient };',
    bannedSdkNames,
    ['exports makeClient,'],
  ],
  [
    'a type prefix with an alias',
    'export { type MCPThing as Thing };',
    new Set(),
    ['exports Thing,'],
  ],
  ['a type-only export list', 'export type { MCPThing };', new Set(), ['exports MCPThing,']],
  [
    'a direct declaration',
    'export { Plain };\nexport declare function createMCPThing(): void;',
    new Set(),
    ['exports createMCPThing,'],
  ],
  [
    'a direct declaration without declare',
    'export { Plain };\nexport interface MCPThing {}',
    new Set(),
    ['exports MCPThing,'],
  ],
  ['an export list that names only banned MCP names', 'export { MCPThing };', MCP_THING, []],
  [
    'plain names have no MCP name to find',
    'export { Plain as Other };\nexport declare const plain: 1;',
    new Set(),
    [NOTHING],
  ],
  [
    'a star re-export blinds the enumeration',
    "export * from 'x';\nexport { MCPThing };",
    MCP_THING,
    [NOTHING],
  ],
  [
    'a named star re-export',
    "export * as ns from 'x';\nexport { MCPThing };",
    MCP_THING,
    [NOTHING],
  ],
  ['a type star re-export', "export type * from 'x';\nexport { MCPThing };", MCP_THING, [NOTHING]],
  ['no export list', 'declare const a: 1;', new Set(), [NOTHING]],
  [
    'no export list, even with a direct MCP declaration',
    'export declare function createMCPThing(): void;',
    new Set(),
    [NOTHING],
  ],
];
for (const [what, declaration, banned, want] of SELF_TESTS) {
  const got = enumerationProblems(declaration, banned);
  if (got.length === want.length && got.every((problem, i) => problem.includes(want[i]))) continue;
  console.error(
    `MCP enumeration self-test failed: ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
  );
  failed = true;
}

// A virtual .cts path under src/ is a fatal parse error, so ask the computed configuration instead.
const ctsConfig = await eslint.calculateConfigForFile(join(root, 'packages/sanitizer/src/x.cts'));
if (ctsConfig.rules?.[LEAF]?.[0] !== 2) {
  console.error(
    'packages/sanitizer/src/x.cts does not carry the sanitizer leaf rule at error level',
  );
  failed = true;
}

if (failed) process.exitCode = 1;
else
  console.log(
    `eslint policy fixtures: OK (${expectedByFile.size} mapped, ${fixtureDirs.length} fixture trees discovered: ${fixtureDirs.join(', ')}, ${witnessRows.length} witness rows)`,
  );
