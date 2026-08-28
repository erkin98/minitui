// Published-artifact gate for the pure-type swap boundary: pack renderer-core + its
// @minitui/types dependency → assert the four-file tarball + manifest (concrete deps,
// engines floor, exact exports) → install into a throwaway strict consumer → tsc
// (types:[] skipLibCheck:false) forces the WHOLE dist/index.d.ts AND its external
// @minitui/types re-exports to resolve with no ambient fallback (declaration-closure +
// §Z80 ambient check) → one ESM import proving the shipped module loads with ZERO runtime
// exports (the package's pure-interface invariant). Proves the SHIPPED tarball, not just
// source. @minitui/types is renderer-core's sole runtime dependency, packed alongside and
// pinned via a pnpm override (its 0.0.0 resolves nowhere else). Permanent (run by the root package
// gate + pre-push).
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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const packagesDir = resolve(pkgDir, '..');
const rootPkg = JSON.parse(readFileSync(resolve(packagesDir, '..', 'package.json'), 'utf8'));
// Control first: a broken checker fails in milliseconds instead of after a full mkdtemp + pack.
assertRootToolchainControl(die);
assertRootToolchain(rootPkg, die);
const tmp = mkdtempSync(join(tmpdir(), 'minitui-renderer-core-pack-'));

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

  // 1. Pack renderer-core + its dependency @minitui/types (workspace:* rewritten concrete on pack).
  const tgz = pack(pkgDir);
  const typesTgz = pack(join(packagesDir, 'types'));
  // 2. Assert EXACTLY the four intended files (a stray/missing file reds).
  const files = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((p) => p.replace(/^package\//, ''))
    .sort();
  const want = ['dist/index.d.ts', 'dist/index.js', 'dist/index.js.map', 'package.json'];
  if (!eq(files, want)) die('packed files ' + JSON.stringify(files) + ' ≠ ' + JSON.stringify(want));
  // 3. Inspect the packed manifest.
  const m = JSON.parse(
    execFileSync('tar', ['-xzOf', tgz, 'package/package.json'], { encoding: 'utf8' }),
  );
  // @minitui/types is renderer-core's sole runtime dependency and its workspace:* MUST be
  // rewritten concrete on pack. assertConcreteDependencies reds if any dependency leaks a
  // non-concrete range (a workspace:*), and the presence check reds if the types dependency
  // is ever dropped from the shipped manifest.
  assertConcreteDependencies(m.dependencies, 'packed manifest', die);
  if (m.dependencies?.['@minitui/types'] === undefined)
    die('packed manifest dropped the @minitui/types dependency: ' + JSON.stringify(m.dependencies));
  // No peer dependencies: assert the container is empty/absent so a regression that
  // reintroduces a workspace:* peer reds here.
  assertConcreteDependencies(m.peerDependencies, 'packed peer manifest', die);
  // Engines floor checked by VALUE against the repo floor (a weakened '*'/'>=18' reds).
  if (m.engines?.node !== EXPECTED_NODE_FLOOR)
    die('packed engines.node ' + JSON.stringify(m.engines?.node) + ' != ' + EXPECTED_NODE_FLOOR);
  // Exports map must ship both conditions, and be EXACTLY the root subpath (a widened map
  // is an unreviewed published-surface change).
  if (!m.exports?.['.']?.types || !m.exports?.['.']?.import)
    die('packed manifest missing exports map: ' + JSON.stringify(m.exports));
  if (!eq(Object.keys(m.exports ?? {}), ['.']))
    die('packed exports subpaths ' + JSON.stringify(Object.keys(m.exports ?? {})) + " ≠ ['.']");
  // 4. Install into a fresh strict consumer. @minitui/types is renderer-core's regular
  // dependency, so its 0.0.0 (which resolves on no registry) is pinned to the local tarball via
  // an override. pnpm 11 reads overrides from pnpm-workspace.yaml, NOT the package.json `pnpm`
  // key — the latter is silently ignored and the offline install fails to resolve 0.0.0.
  writeFileSync(
    join(tmp, 'package.json'),
    JSON.stringify({
      name: 'c',
      private: true,
      type: 'module',
      packageManager: EXPECTED_PACKAGE_MANAGER,
      dependencies: { '@minitui/renderer-core': 'file:' + tgz },
    }),
  );
  writeFileSync(
    join(tmp, 'pnpm-workspace.yaml'),
    'packages: []\n' + 'overrides:\n' + "  '@minitui/types': file:" + typesTgz + '\n',
  );
  writeFileSync(
    join(tmp, 'tsconfig.json'),
    JSON.stringify({
      // lib ES2023 (NO dom — mirrors the package's own tsconfig.base) so a Node ambient
      // cannot resolve from lib.dom; types:[] excludes ambient @types/*. @minitui/types'
      // own `/// <reference types="node" />` triple-slash still pulls @types/node (shipped
      // as its dependency), so its AbortSignal resolves while renderer-core's own surface —
      // which references no Node ambient — is fully checked.
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
  // types:[] + lib:[ES2023] + skipLibCheck:false forces a full check of the WHOLE
  // dist/index.d.ts AND its external @minitui/types re-exports with no ambient fallback —
  // an undeclared global reds TS2304. This probe is ALSO the standing surface-reachability
  // gate for the barrel: it imports ALL NINE public names, so dropping any barrel re-export
  // reds TS2305 here on the SHIPPED artifact. Neither `tsc -b` (src-only tsconfig) nor
  // vitest (type-only witnesses erase) can see such a drop, so this is the only gate that
  // does. `ActionKind` forced through as a value additionally proves the external re-export
  // chain resolves; the interface names use type-alias witnesses (no runtime, so the
  // zero-runtime-export ESM probe below stays intact).
  writeFileSync(
    join(tmp, 'probe.ts'),
    'import type {\n' +
      '  RendererPort,\n' +
      '  RenderHandle,\n' +
      '  WidgetCatalogBinding,\n' +
      '  ActionDispatcher,\n' +
      '  ActionKind,\n' +
      '  DispatchContext,\n' +
      '  ActionOutcome,\n' +
      '  ActionLifecycleEvent,\n' +
      '  LifecycleEmitter,\n' +
      "} from '@minitui/renderer-core';\n" +
      "export const _k: ActionKind = 'render-local';\n" +
      "export const _o: ActionOutcome = { status: 'settled' };\n" +
      "export const _e: ActionLifecycleEvent = { phase: 'started', actionName: 'x', elementKey: 'k' };\n" +
      'export type _Port = RendererPort;\n' +
      'export type _Handle = RenderHandle;\n' +
      'export type _Binding = WidgetCatalogBinding;\n' +
      'export type _Dispatcher = ActionDispatcher;\n' +
      'export type _Ctx = DispatchContext;\n' +
      'export type _Emitter = LifecycleEmitter;\n',
  );
  // The ESM probe proves the shipped module LOADS and carries ZERO runtime exports —
  // renderer-core is pure interfaces, so every export is type-only and erases at runtime.
  writeFileSync(
    join(tmp, 'run.mjs'),
    "import * as RC from '@minitui/renderer-core';\n" +
      "if (typeof RC !== 'object') throw new Error('ESM import broken on shipped dist');\n" +
      'if (Object.keys(RC).length !== 0)\n' +
      "  throw new Error('renderer-core leaked a runtime export: ' + Object.keys(RC));\n",
  );
  execFileSync('pnpm', ['install', '--offline'], { cwd: tmp, stdio: 'inherit' });
  // 5. Compile (declaration closure) + run the ESM probe. tsc comes from the repo toolchain
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
