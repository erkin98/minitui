// NOT YET WIRED into root `pack:check`: the `--offline` install below fails with
// ERR_PNPM_NO_OFFLINE_META for `@anthropic-ai/sandbox-runtime@0.0.60`, whose resolution metadata is
// not in the offline mirror the resolver reads. Until that is resolved, a run counts as passing when
// every check before the install printed OK and the install fails with ERR_PNPM_NO_OFFLINE_META at
// the `pnpm install --offline` step; any earlier failure is a defect of this script or the package.
//
// Published-artifact gate: pack exec (+ its internal workspace deps @minitui/types,
// @minitui/renderer-core and @minitui/sanitizer) → assert the seven-file tarball, the manifest
// (concrete deps, @types/node shipped as a dependency, engines floor, exact exports) and the
// declaration banner → install into a throwaway strict consumer with --offline → tsc (types:[],
// lib ES2023, skipLibCheck:false) forces the WHOLE dist/index.d.ts to resolve with no ambient
// fallback → one ESM import that loads the shipped grammar and parses one command. Proves the
// tarball, not just source. The internal deps (0.0.0, on no registry) are packed alongside and
// pinned via pnpm overrides.
/* global console, process, URL */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED_NODE_FLOOR,
  EXPECTED_PACKAGE_MANAGER,
  assertConcreteDependencies,
  assertConcreteSemverControl,
  assertRootToolchain,
  assertRootToolchainControl,
} from '../../../scripts/pack-contract.mjs';

// die() THROWS (never process.exit) so the finally-block temp-dir cleanup always runs.
const die = (m) => {
  throw new Error(m);
};
const ok = (what) => console.log('pack-consumer: ' + what + ' OK');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const packagesDir = resolve(pkgDir, '..');
const rootPkg = JSON.parse(readFileSync(resolve(packagesDir, '..', 'package.json'), 'utf8'));
// Control first: a broken checker fails in milliseconds instead of after a full mkdtemp + pack.
assertRootToolchainControl(die);
assertRootToolchain(rootPkg, die);
const tmp = mkdtempSync(join(tmpdir(), 'minitui-exec-pack-'));

const pack = (dir) => {
  const out = JSON.parse(
    execFileSync('pnpm', ['pack', '--pack-destination', tmp, '--json'], {
      cwd: dir,
      encoding: 'utf8',
    }),
  );
  return resolve(tmp, out.filename ?? die('pnpm pack emitted no filename for ' + dir));
};

const DECLARATION_BANNER = '/// <reference types="node" />';
const INTERNAL_DEPS = ['@minitui/types', '@minitui/renderer-core', '@minitui/sanitizer'];

try {
  assertConcreteSemverControl(die);
  ok('toolchain and semver controls');

  // 1. Pack exec + its internal dependencies (catalog: and workspace: rewritten concrete on pack).
  const tgz = pack(pkgDir);
  const internalTgz = INTERNAL_DEPS.map((name) => [
    name,
    pack(join(packagesDir, name.slice('@minitui/'.length))),
  ]);
  // 2. Assert EXACTLY the seven intended files: exec is the one package that ships a runtime asset
  // (the bash grammar and the parser runtime); pnpm pack adds the root LICENSE.
  const files = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((p) => p.replace(/^package\//, ''))
    .sort();
  const want = [
    'LICENSE',
    'dist/index.d.ts',
    'dist/index.js',
    'dist/index.js.map',
    'dist/tree-sitter-bash.wasm',
    'dist/tree-sitter.wasm',
    'package.json',
  ];
  if (!eq(files, want)) die('packed files ' + JSON.stringify(files) + ' ≠ ' + JSON.stringify(want));
  ok('packed file set');
  // 3. Inspect the packed manifest.
  const m = JSON.parse(
    execFileSync('tar', ['-xzOf', tgz, 'package/package.json'], { encoding: 'utf8' }),
  );
  assertConcreteDependencies(m.dependencies, 'packed manifest', die);
  assertConcreteDependencies(m.peerDependencies, 'packed peer manifest', die);
  for (const name of INTERNAL_DEPS) {
    if (m.dependencies?.[name] === undefined)
      die('packed manifest dropped the ' + name + ' dependency: ' + JSON.stringify(m.dependencies));
  }
  // The declarations name NodeJS.ProcessEnv, NodeJS.Platform and AbortSignal: @types/node must ship
  // as a dependency (not a devDependency) for the banner below to resolve in a consumer.
  if (m.dependencies?.['@types/node'] === undefined)
    die('packed manifest lists no @types/node dependency: ' + JSON.stringify(m.dependencies));
  if (m.engines?.node !== EXPECTED_NODE_FLOOR)
    die('packed engines.node ' + JSON.stringify(m.engines?.node) + ' != ' + EXPECTED_NODE_FLOOR);
  if (!m.exports?.['.']?.types || !m.exports?.['.']?.import)
    die('packed manifest missing exports map: ' + JSON.stringify(m.exports));
  if (!eq(Object.keys(m.exports ?? {}), ['.']))
    die('packed exports subpaths ' + JSON.stringify(Object.keys(m.exports ?? {})) + " ≠ ['.']");
  ok('packed manifest');
  // 4. The shipped declarations start with the banner and import nothing from the sandbox runtime.
  const dts = execFileSync('tar', ['-xzOf', tgz, 'package/dist/index.d.ts'], { encoding: 'utf8' });
  if (!dts.startsWith(DECLARATION_BANNER))
    die('packed dist/index.d.ts does not start with ' + JSON.stringify(DECLARATION_BANNER));
  if (dts.includes('@anthropic-ai/sandbox-runtime'))
    die('packed dist/index.d.ts names the sandbox runtime');
  ok('declaration banner and runtime-free declarations');
  // 5. Install into a fresh strict consumer. The internal deps' 0.0.0 resolves nowhere else, so each
  // is pinned to its local tarball via an override; pnpm 11 reads overrides from
  // pnpm-workspace.yaml, NOT the package.json `pnpm` key.
  writeFileSync(
    join(tmp, 'package.json'),
    JSON.stringify({
      name: 'c',
      private: true,
      type: 'module',
      packageManager: EXPECTED_PACKAGE_MANAGER,
      dependencies: { '@minitui/exec': 'file:' + tgz },
    }),
  );
  writeFileSync(
    join(tmp, 'pnpm-workspace.yaml'),
    'packages: []\noverrides:\n' +
      internalTgz.map(([name, file]) => "  '" + name + "': file:" + file + '\n').join(''),
  );
  writeFileSync(
    join(tmp, 'tsconfig.json'),
    JSON.stringify({
      // lib ES2023 (NO dom) + types:[] so no ambient global resolves from lib.dom or an
      // auto-included @types/*: AbortSignal and NodeJS.* must come through the banner, from the
      // @types/node this package ships. skipLibCheck:false checks the WHOLE dist/index.d.ts.
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        lib: ['ES2023'],
        skipLibCheck: false,
        types: [],
        noEmit: true,
      },
      files: ['probe.ts'],
    }),
  );
  // The probe names every public export (eight values, seven types), so a dropped re-export reds
  // TS2305 on the SHIPPED artifact.
  writeFileSync(
    join(tmp, 'probe.ts'),
    'import {\n' +
      '  SandboxUnavailableError,\n' +
      '  SandboxViolationError,\n' +
      '  checkHardFloor,\n' +
      '  checkPathRules,\n' +
      '  createPermissionEngine,\n' +
      '  createSandboxManager,\n' +
      '  ensureParserReady,\n' +
      '  parseShellCommand,\n' +
      "} from '@minitui/exec';\n" +
      'import type {\n' +
      '  PathRule,\n' +
      '  PermissionEngine,\n' +
      '  SandboxManagerHandle,\n' +
      '  SandboxPolicy,\n' +
      '  SandboxProbe,\n' +
      '  SandboxViolation,\n' +
      '  WrappedArgv,\n' +
      "} from '@minitui/exec';\n" +
      'export const _values = [\n' +
      '  SandboxUnavailableError,\n' +
      '  SandboxViolationError,\n' +
      '  checkHardFloor,\n' +
      '  checkPathRules,\n' +
      '  createPermissionEngine,\n' +
      '  createSandboxManager,\n' +
      '  ensureParserReady,\n' +
      '  parseShellCommand,\n' +
      '] as const;\n' +
      'export type _Types = [\n' +
      '  PathRule,\n' +
      '  PermissionEngine,\n' +
      '  SandboxManagerHandle,\n' +
      '  SandboxPolicy,\n' +
      '  SandboxProbe,\n' +
      '  SandboxViolation,\n' +
      '  WrappedArgv,\n' +
      '];\n',
  );
  // The ESM probe loads the shipped module and its runtime asset: the grammar parses one command.
  writeFileSync(
    join(tmp, 'run.mjs'),
    "import { ensureParserReady, parseShellCommand } from '@minitui/exec';\n" +
      'await ensureParserReady();\n' +
      "const parsed = parseShellCommand('echo hi');\n" +
      "if (parsed.parseError || parsed.roots.length !== 1 || parsed.roots[0].name !== 'echo')\n" +
      "  throw new Error('the shipped parser did not parse one command: ' + JSON.stringify(parsed));\n",
  );
  console.log('pack-consumer: installing into the throwaway consumer (offline)');
  execFileSync('pnpm', ['install', '--offline'], { cwd: tmp, stdio: 'inherit' });
  // 6. Compile (declaration closure) + run the ESM probe. tsc comes from the repo toolchain
  // (catalog-pinned) run AGAINST the consumer project.
  execFileSync('pnpm', ['exec', 'tsc', '--noEmit', '-p', join(tmp, 'tsconfig.json')], {
    cwd: pkgDir,
    stdio: 'inherit',
  });
  execFileSync('node', ['run.mjs'], { cwd: tmp, stdio: 'inherit' });
  console.log('pack-consumer gate: OK');
} catch (e) {
  console.error('pack-consumer gate: ' + (e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
