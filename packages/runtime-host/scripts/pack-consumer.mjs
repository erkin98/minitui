// Published-artifact gate: pack, assert the tarball and its manifest, install into a throwaway strict
// consumer, compile (types: [], lib ES2023, skipLibCheck: true) so the whole dist/index.d.ts and its
// re-exports must resolve, then run one ESM import against the shipped surface. The host's runtime
// closure holds six internal workspace packages (types, transport, spec, renderer-core, and through
// them sanitizer and catalog); their 0.0.0 versions are on no registry, so they are packed alongside and
// pinned by pnpm overrides. External packages resolve from the offline store.
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

// die() throws instead of exiting, so the finally block always removes the temporary directory.
const die = (m) => {
  throw new Error(m);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const packagesDir = resolve(pkgDir, '..');
const rootPkg = JSON.parse(readFileSync(resolve(packagesDir, '..', 'package.json'), 'utf8'));
// The checkers are proven on a planted failure first: pure and free, so a broken checker fails before
// any temporary directory exists.
assertRootToolchainControl(die);
assertRootToolchain(rootPkg, die);
const tmp = mkdtempSync(join(tmpdir(), 'minitui-runtime-host-pack-'));

const pack = (dir) => {
  const out = JSON.parse(
    execFileSync('pnpm', ['pack', '--pack-destination', tmp, '--json'], {
      cwd: dir,
      encoding: 'utf8',
    }),
  );
  return resolve(tmp, out.filename ?? die('pnpm pack emitted no filename for ' + dir));
};

try {
  assertConcreteSemverControl(die);

  // 1. Pack the host and every internal package in its runtime closure.
  const tgz = pack(pkgDir);
  const tarballs = Object.fromEntries(
    ['types', 'sanitizer', 'transport', 'renderer-core', 'catalog', 'spec'].map((name) => [
      name,
      pack(join(packagesDir, name)),
    ]),
  );
  // 2. Exactly the five intended files; pnpm pack adds LICENSE.
  const files = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((p) => p.replace(/^package\//, ''))
    .sort();
  const want = ['LICENSE', 'dist/index.d.ts', 'dist/index.js', 'dist/index.js.map', 'package.json'];
  if (!eq(files, want))
    die('packed files ' + JSON.stringify(files) + ' != ' + JSON.stringify(want));
  // 3. The packed manifest: workspace and catalog ranges rewritten concrete, engines and exports intact.
  const m = JSON.parse(
    execFileSync('tar', ['-xzOf', tgz, 'package/package.json'], { encoding: 'utf8' }),
  );
  assertConcreteDependencies(m.dependencies, 'packed manifest', die);
  if (m.engines?.node !== EXPECTED_NODE_FLOOR)
    die('packed engines.node ' + JSON.stringify(m.engines?.node) + ' != ' + EXPECTED_NODE_FLOOR);
  if (!m.exports?.['.']?.types || !m.exports?.['.']?.import)
    die('packed manifest missing exports map: ' + JSON.stringify(m.exports));
  if (!eq(Object.keys(m.exports ?? {}), ['.']))
    die('packed exports subpaths ' + JSON.stringify(Object.keys(m.exports ?? {})) + " != ['.']");
  // 4. A fresh strict consumer. The overrides pin each internal package to its tarball; react, ink and
  // marked are pinned to the versions the repo lockfile resolves, the only ones in the offline store.
  writeFileSync(
    join(tmp, 'package.json'),
    JSON.stringify({
      name: 'c',
      private: true,
      type: 'module',
      packageManager: EXPECTED_PACKAGE_MANAGER,
      dependencies: { '@minitui/runtime-host': 'file:' + tgz },
    }),
  );
  writeFileSync(
    join(tmp, 'pnpm-workspace.yaml'),
    'packages: []\n' +
      'overrides:\n' +
      Object.entries(tarballs)
        .map(([name, file]) => "  '@minitui/" + name + "': file:" + file + '\n')
        .join('') +
      '  react: 19.2.4\n' +
      '  ink: 6.8.0\n' +
      '  marked: 17.0.6\n',
  );
  writeFileSync(
    join(tmp, 'tsconfig.json'),
    JSON.stringify({
      // lib ES2023 (no DOM) and types: [] so no ambient global resolves by accident. skipLibCheck is true
      // because the catalog closure type-imports react, for which a React-free package ships no types;
      // the reachability probe below still bites, since a dropped export is TS2305 whatever skipLibCheck says.
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        lib: ['ES2023'],
        skipLibCheck: true,
        types: [],
        noEmit: true,
      },
      files: ['probe.ts'],
    }),
  );
  // The barrel's reachability gate: the probe names every public value and type of the shipped artifact.
  writeFileSync(
    join(tmp, 'probe.ts'),
    "import { createAppHost, bindRelaunchParams, BindError } from '@minitui/runtime-host';\n" +
      'import type {\n' +
      '  AppHost, AppHostDeps, HostSession, TaskOutcome, HostState, BindInput, BindResult,\n' +
      "} from '@minitui/runtime-host';\n" +
      'export const _values = [createAppHost, bindRelaunchParams, BindError] as const;\n' +
      'export type _T = [\n' +
      '  AppHost, AppHostDeps, HostSession, TaskOutcome, HostState, BindInput, BindResult,\n' +
      '];\n',
  );
  // The shipped ESM dist loads, and a pure value of it runs.
  writeFileSync(
    join(tmp, 'run.mjs'),
    "import { createAppHost, bindRelaunchParams, BindError } from '@minitui/runtime-host';\n" +
      "if (typeof createAppHost !== 'function') throw new Error('createAppHost missing on shipped dist');\n" +
      'const r = bindRelaunchParams({\n' +
      "  params: [{ name: 'a/b', label: 'x', classification: 'prompt', secret: true }],\n" +
      '  persisted: {},\n' +
      "  answers: { 'a/b': '1' },\n" +
      '});\n' +
      "if (r.data['a/b'] !== '1' || r.secretPointers[0] !== '/a~1b')\n" +
      "  throw new Error('bindRelaunchParams broken on shipped dist');\n" +
      'try {\n' +
      "  bindRelaunchParams({ params: [{ name: 'k', label: 'x', classification: 'prompt', secret: false }], persisted: {}, answers: {} });\n" +
      "  throw new Error('a missing answer was accepted on shipped dist');\n" +
      '} catch (err) {\n' +
      "  if (!(err instanceof BindError)) throw new Error('BindError not thrown on shipped dist');\n" +
      '}\n',
  );
  execFileSync('pnpm', ['install', '--offline'], { cwd: tmp, stdio: 'inherit' });
  // 5. Compile the declaration closure, then run the ESM probe. tsc comes from the repo toolchain.
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
