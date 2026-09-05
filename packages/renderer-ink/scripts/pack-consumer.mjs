// Published-artifact gate for the renderer swap boundary + render chokepoint: pack
// renderer-ink + its four internal workspace deps → assert the four-file tarball +
// manifest (concrete deps, engines floor, exact exports) → install into a throwaway
// strict consumer → tsc (types:[], lib ES2023, skipLibCheck:true) forces the WHOLE
// dist/index.d.ts AND its external re-exports to resolve → one ESM import that loads the
// shipped dist and asserts the swap-boundary surface is present. Proves the tarball, not
// just source. renderer-ink has four internal workspace deps in its runtime closure —
// @minitui/types, @minitui/sanitizer, @minitui/renderer-core, @minitui/catalog — packed
// alongside and pinned via pnpm overrides; their 0.0.0 versions are on no registry. Its
// external deps (@json-render/core, @json-render/ink, ink, react, fast-json-patch) resolve
// from the offline store — the same volatile react/ink/marked transitives the catalog and
// spec gates already resolve offline. Permanent (run by the root package gate + pre-push).
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

// die() THROWS (never process.exit) so the finally-block temp-dir cleanup always runs —
// process.exit() skips finally and would leak the mkdtemp dir on every gate failure.
const die = (m) => {
  throw new Error(m);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const packagesDir = resolve(pkgDir, '..');
// Repo root is the single source of truth for the Node floor + the pinned pnpm — read
// them (no second hardcoded copy) so the throwaway consumer install uses the repo's
// pinned pnpm, not an ambient one, and the packed engines floor is checked by value.
const rootPkg = JSON.parse(readFileSync(resolve(packagesDir, '..', 'package.json'), 'utf8'));
// Control first: pure and free, so a broken checker fails in milliseconds instead of
// after a full mkdtemp + pack.
assertRootToolchainControl(die);
assertRootToolchain(rootPkg, die);
const tmp = mkdtempSync(join(tmpdir(), 'minitui-renderer-ink-pack-'));

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

  // 1. Pack renderer-ink + its four internal workspace deps (workspace:* rewritten concrete on pack).
  const tgz = pack(pkgDir);
  const typesTgz = pack(join(packagesDir, 'types'));
  const sanitizerTgz = pack(join(packagesDir, 'sanitizer'));
  const rendererCoreTgz = pack(join(packagesDir, 'renderer-core'));
  const catalogTgz = pack(join(packagesDir, 'catalog'));
  // 2. Assert EXACTLY the four intended files (a stray/missing file reds).
  const files = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((p) => p.replace(/^package\//, ''))
    .sort();
  const want = ['dist/index.d.ts', 'dist/index.js', 'dist/index.js.map', 'package.json'];
  if (!eq(files, want)) die('packed files ' + JSON.stringify(files) + ' ≠ ' + JSON.stringify(want));
  // 3. Inspect the packed manifest: catalog:/workspace: rewritten concrete, engines present.
  const m = JSON.parse(
    execFileSync('tar', ['-xzOf', tgz, 'package/package.json'], { encoding: 'utf8' }),
  );
  // Every dep (the four internal workspace deps + @json-render/core + @json-render/ink +
  // ink + react + fast-json-patch) MUST be a concrete semver — a leaked workspace:* or a
  // range reds here.
  assertConcreteDependencies(m.dependencies, 'packed manifest', die);
  // Engines floor checked by VALUE against the repo floor (not mere presence): a
  // weakened '*'/'>=18' or a dropped range reds instead of silently passing.
  if (m.engines?.node !== EXPECTED_NODE_FLOOR)
    die('packed engines.node ' + JSON.stringify(m.engines?.node) + ' != ' + EXPECTED_NODE_FLOOR);
  // Exports map must ship both the types + import conditions — a deleted/half exports
  // map breaks every consumer's resolution yet would otherwise pass unchecked.
  if (!m.exports?.['.']?.types || !m.exports?.['.']?.import)
    die('packed manifest missing exports map: ' + JSON.stringify(m.exports));
  // Exports map must be EXACTLY the root subpath. A widened map (a new "./internal" entry)
  // is a published-surface change and reds here rather than shipping unreviewed.
  if (!eq(Object.keys(m.exports ?? {}), ['.']))
    die('packed exports subpaths ' + JSON.stringify(Object.keys(m.exports ?? {})) + " ≠ ['.']");
  // 4. Install the tarballs into a fresh strict consumer. Overrides pin the four internal
  // deps to the local tarballs (0.0.0 resolves nowhere else). pnpm 11 reads overrides from
  // pnpm-workspace.yaml, NOT the package.json `pnpm` key.
  writeFileSync(
    join(tmp, 'package.json'),
    JSON.stringify({
      name: 'c',
      private: true,
      type: 'module',
      packageManager: EXPECTED_PACKAGE_MANAGER,
      dependencies: { '@minitui/renderer-ink': 'file:' + tgz },
    }),
  );
  // The four internal deps pin to the local tarballs. renderer-ink (and catalog's
  // @json-render/ink transitive) hard-depend on react/ink/marked with RANGES; pin those
  // three volatile transitives to the versions the repo lockfile resolves — the only ones
  // guaranteed in the offline store — so the gate is deterministic and offline.
  writeFileSync(
    join(tmp, 'pnpm-workspace.yaml'),
    'packages: []\n' +
      'overrides:\n' +
      "  '@minitui/types': file:" +
      typesTgz +
      '\n' +
      "  '@minitui/sanitizer': file:" +
      sanitizerTgz +
      '\n' +
      "  '@minitui/renderer-core': file:" +
      rendererCoreTgz +
      '\n' +
      "  '@minitui/catalog': file:" +
      catalogTgz +
      '\n' +
      '  react: 19.2.4\n' +
      '  ink: 6.8.0\n' +
      '  marked: 17.0.6\n',
  );
  writeFileSync(
    join(tmp, 'tsconfig.json'),
    JSON.stringify({
      // lib ES2023 (NO dom) + types:[] so no ambient global resolves from lib.dom or an
      // auto-included @types/*. skipLibCheck:true (like the catalog gate): renderer-ink's
      // barrel re-exports React/ink/@json-render types, and a React-free consumer ships no
      // @types/react, so skipLibCheck:false would false-positive on those adopted, type-only
      // imports. The barrel-reachability check below still bites (a dropped export is TS2305,
      // reported regardless of skipLibCheck).
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
  // The standing surface-reachability gate for the barrel: this probe names EVERY public
  // type + value, so dropping any barrel re-export reds TS2305 (an export-RESOLUTION error,
  // reported regardless of skipLibCheck) here on the SHIPPED artifact. Neither `tsc -b`
  // (src-only tsconfig) nor vitest (type-only witnesses erase) can see such a drop.
  writeFileSync(
    join(tmp, 'probe.ts'),
    'import {\n' +
      '  createInkRenderer,\n' +
      '  assertSpecOnCatalog,\n' +
      '  makeOffCatalogFallback,\n' +
      '  mountInk,\n' +
      '  buildHandlers,\n' +
      '  ELEMENT_KEY,\n' +
      '  gatedHandler,\n' +
      '  RENDER_LOCAL_ALLOWLIST,\n' +
      '  isRenderLocalAllowed,\n' +
      '  ConsentOverlay,\n' +
      '  CommandPreview,\n' +
      '  createInkBinding,\n' +
      '  Button,\n' +
      '  FilePicker,\n' +
      '  OrderList,\n' +
      '  ProgressWidget,\n' +
      "} from '@minitui/renderer-ink';\n" +
      'import type {\n' +
      '  InkRendererDeps,\n' +
      '  MountInkArgs,\n' +
      '  BuildHandlersArgs,\n' +
      '  GatedHandlerArgs,\n' +
      '  ConsentController,\n' +
      '  ConsentDecision,\n' +
      '  WidgetProps,\n' +
      "} from '@minitui/renderer-ink';\n" +
      // Force every value re-export to resolve (TS2305 on any drop) without executing.
      'export const _values = [\n' +
      '  createInkRenderer, assertSpecOnCatalog, makeOffCatalogFallback, mountInk,\n' +
      '  buildHandlers, ELEMENT_KEY, gatedHandler, RENDER_LOCAL_ALLOWLIST,\n' +
      '  isRenderLocalAllowed, ConsentOverlay, CommandPreview, createInkBinding,\n' +
      '  Button, FilePicker, OrderList, ProgressWidget,\n' +
      '] as const;\n' +
      // Type witnesses — one alias per public type name (TS2305 on any drop). MountInkArgs,
      // InkRendererDeps and WidgetProps pull the external @minitui/* type re-export chains.
      'export type _T = [\n' +
      '  InkRendererDeps, MountInkArgs, BuildHandlersArgs, GatedHandlerArgs,\n' +
      '  ConsentController, ConsentDecision, WidgetProps,\n' +
      '];\n' +
      // Force an external re-export chain to resolve as a VALUE.
      'export const _key: string = ELEMENT_KEY;\n',
  );
  // The runtime probe proves the shipped ESM dist loads and its swap-boundary surface is
  // intact: every barrel factory/widget is callable, the injected element-key is a real
  // string, and the render-local allowlist is STATE-only on the shipped artifact (setState
  // in, a non-state action out).
  writeFileSync(
    join(tmp, 'run.mjs'),
    'import {\n' +
      '  createInkRenderer,\n' +
      '  mountInk,\n' +
      '  buildHandlers,\n' +
      '  gatedHandler,\n' +
      '  createInkBinding,\n' +
      '  assertSpecOnCatalog,\n' +
      '  makeOffCatalogFallback,\n' +
      '  isRenderLocalAllowed,\n' +
      '  ConsentOverlay,\n' +
      '  CommandPreview,\n' +
      '  Button,\n' +
      '  FilePicker,\n' +
      '  OrderList,\n' +
      '  ProgressWidget,\n' +
      '  ELEMENT_KEY,\n' +
      '  RENDER_LOCAL_ALLOWLIST,\n' +
      "} from '@minitui/renderer-ink';\n" +
      'const surface = {\n' +
      '  createInkRenderer, mountInk, buildHandlers, gatedHandler, createInkBinding,\n' +
      '  assertSpecOnCatalog, makeOffCatalogFallback, isRenderLocalAllowed,\n' +
      '  ConsentOverlay, CommandPreview, Button, FilePicker, OrderList, ProgressWidget,\n' +
      '};\n' +
      'for (const [name, fn] of Object.entries(surface))\n' +
      "  if (typeof fn !== 'function')\n" +
      "    throw new Error('barrel export not callable on shipped dist: ' + name);\n" +
      "if (typeof ELEMENT_KEY !== 'string' || ELEMENT_KEY.length === 0)\n" +
      "  throw new Error('ELEMENT_KEY missing on shipped dist');\n" +
      "if (!(RENDER_LOCAL_ALLOWLIST instanceof Set) || !RENDER_LOCAL_ALLOWLIST.has('setState'))\n" +
      "  throw new Error('RENDER_LOCAL_ALLOWLIST not a STATE allowlist on shipped dist');\n" +
      "if (isRenderLocalAllowed('setState') !== true || isRenderLocalAllowed('exec') !== false)\n" +
      "  throw new Error('isRenderLocalAllowed not STATE-only on shipped dist');\n",
  );
  execFileSync('pnpm', ['install', '--offline'], { cwd: tmp, stdio: 'inherit' });
  // 5. Compile (declaration closure) + run the ESM probe. tsc comes from the repo
  // toolchain (renderer-ink-pinned) run AGAINST the consumer project.
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
