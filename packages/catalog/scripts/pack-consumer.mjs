// Published-artifact gate: pack → assert tar (4 files) + manifest → install into a
// throwaway strict consumer → tsc (types:[], lib ES2023, skipLibCheck:true) forces the
// WHOLE dist/index.d.ts AND its external re-exports (@minitui/*, @json-render/ink/server,
// @json-render/core, zod) to resolve → one ESM import that
// EXERCISES the two-point no-code gate on the SHIPPED dist. Proves the tarball, not
// just source. Catalog has three internal workspace deps (types, renderer-core,
// sanitizer) packed alongside and pinned via pnpm overrides — their 0.0.0 versions
// are on no registry; its external deps (@json-render/core, @json-render/ink, zod)
// resolve from the offline store. Permanent (run by the root package gate + pre-push).
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
const tmp = mkdtempSync(join(tmpdir(), 'minitui-catalog-pack-'));

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

  // 1. Pack catalog + its three internal workspace deps (workspace:* rewritten concrete on pack).
  const tgz = pack(pkgDir);
  const typesTgz = pack(join(packagesDir, 'types'));
  const rendererCoreTgz = pack(join(packagesDir, 'renderer-core'));
  const sanitizerTgz = pack(join(packagesDir, 'sanitizer'));
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
  // Every dep (the three internal 0.0.0 workspace deps + json-render core/ink + zod)
  // MUST be a concrete semver — a leaked workspace:* or a range reds here.
  assertConcreteDependencies(m.dependencies, 'packed manifest', die);
  // Engines floor checked by VALUE against the repo floor (not mere presence): a
  // weakened '*'/'>=18' or a dropped range reds instead of silently passing.
  if (m.engines?.node !== EXPECTED_NODE_FLOOR)
    die('packed engines.node ' + JSON.stringify(m.engines?.node) + ' != ' + EXPECTED_NODE_FLOOR);
  // Exports map must ship both the types + import conditions — a deleted/half exports
  // map breaks every consumer's resolution yet would otherwise pass unchecked.
  if (!m.exports?.['.']?.types || !m.exports?.['.']?.import)
    die('packed manifest missing exports map: ' + JSON.stringify(m.exports));
  // Exports map must be EXACTLY the root subpath. A widened map (a new "./internal"
  // or "./unstable" entry) is a published-surface change and reds here rather than
  // shipping unreviewed; presence-only checking cannot see it.
  if (!eq(Object.keys(m.exports ?? {}), ['.']))
    die('packed exports subpaths ' + JSON.stringify(Object.keys(m.exports ?? {})) + " ≠ ['.']");
  // 4. Install the tarballs into a fresh strict consumer. Overrides pin the three
  // internal deps to the local tarballs (0.0.0 resolves nowhere else). pnpm 11
  // reads overrides from pnpm-workspace.yaml, NOT the package.json `pnpm` key — the
  // latter is silently ignored and the install 404s on the registry.
  writeFileSync(
    join(tmp, 'package.json'),
    JSON.stringify({
      name: 'c',
      private: true,
      type: 'module',
      packageManager: EXPECTED_PACKAGE_MANAGER,
      dependencies: { '@minitui/catalog': 'file:' + tgz },
    }),
  );
  // The three internal deps pin to the local tarballs. @json-render/ink hard-depends
  // on react/ink/marked with RANGES; a clean-room install would drift to whatever is
  // latest (a moving, un-cached target that breaks the offline install). Pin those
  // three volatile transitives to the versions the repo lockfile resolves — the only
  // ones guaranteed in the offline store — so the gate is deterministic and offline.
  writeFileSync(
    join(tmp, 'pnpm-workspace.yaml'),
    'packages: []\n' +
      'overrides:\n' +
      "  '@minitui/types': file:" +
      typesTgz +
      '\n' +
      "  '@minitui/renderer-core': file:" +
      rendererCoreTgz +
      '\n' +
      "  '@minitui/sanitizer': file:" +
      sanitizerTgz +
      '\n' +
      '  react: 19.2.4\n' +
      '  ink: 6.8.0\n' +
      '  marked: 17.0.6\n',
  );
  writeFileSync(
    join(tmp, 'tsconfig.json'),
    JSON.stringify({
      // lib ES2023 (NO dom) + types:[] so no ambient global resolves from lib.dom or
      // an auto-included @types/*. skipLibCheck:true here (unlike the pure-interface
      // sibling gates) is deliberate: catalog re-exports two React-FREE defs
      // (ComponentDefinition, ActionDefinition) from '@json-render/ink/server', whose
      // own .d.ts ALSO type-imports `react` for render-fn types (ComponentFn/Components)
      // catalog never re-exports. A React-free package ships no @types/react, so
      // skipLibCheck:false would false-positive on that adopted, type-only react import.
      // Catalog's OWN surface references no Node/DOM ambient (verified — no triple-slash,
      // no Buffer/process/AbortSignal in dist/index.d.ts), so the ambient-closure check
      // loses nothing real; the barrel-reachability check below still bites (a dropped
      // export is an export-RESOLUTION error TS2305, reported regardless of skipLibCheck).
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
  // The standing surface-reachability gate for the barrel: this probe names EVERY
  // public type + value, so dropping any barrel re-export reds TS2305 (an export-
  // RESOLUTION error, reported regardless of skipLibCheck) here on the SHIPPED
  // artifact. Neither `tsc -b` (src-only tsconfig) nor vitest (type-only witnesses
  // erase) can see such a drop.
  writeFileSync(
    join(tmp, 'probe.ts'),
    'import {\n' +
      '  defineAction,\n' +
      '  requiresPermission,\n' +
      '  defineComponent,\n' +
      '  applyResourceTemplate,\n' +
      '  resolvePointer,\n' +
      '  isWiderThan,\n' +
      '  DEFAULT_VISIBILITY,\n' +
      '  SECRET_VISIBILITY,\n' +
      '  standardComponentDefinitions,\n' +
      '  standardActionDefinitions,\n' +
      '  STD_ACTION_NAMES,\n' +
      '  defineMinituiCatalog,\n' +
      '  rejectOffCatalog,\n' +
      '  throwingFallback,\n' +
      '  checkSemantics,\n' +
      '  CATALOG_REPAIR_WORDING,\n' +
      '  runFullValidation,\n' +
      '  buildCatalogPrompt,\n' +
      '  sanitize,\n' +
      '  sanitizeSpecStrings,\n' +
      '  videoMergeCatalog,\n' +
      "} from '@minitui/catalog';\n" +
      'import type {\n' +
      '  MinituiActionDef,\n' +
      '  MinituiComponentDef,\n' +
      '  TrustTier,\n' +
      '  ActionKind,\n' +
      '  PermissionDescriptor,\n' +
      '  VisibilityClass,\n' +
      '  ActionBinding,\n' +
      '  AppSpec,\n' +
      '  SpecElement,\n' +
      '  ComponentDefinition,\n' +
      '  ActionDefinition,\n' +
      '  MinituiCatalog,\n' +
      '  AllowlistIssue,\n' +
      '  SemanticIssue,\n' +
      '  ValidationIssue,\n' +
      '  ValidationResult,\n' +
      "} from '@minitui/catalog';\n" +
      // Force every value re-export to resolve (TS2305 on any drop) without executing.
      'export const _values = [\n' +
      '  defineAction, requiresPermission, defineComponent, applyResourceTemplate,\n' +
      '  resolvePointer, isWiderThan, DEFAULT_VISIBILITY, SECRET_VISIBILITY,\n' +
      '  standardComponentDefinitions, standardActionDefinitions, STD_ACTION_NAMES,\n' +
      '  defineMinituiCatalog, rejectOffCatalog, throwingFallback, checkSemantics,\n' +
      '  CATALOG_REPAIR_WORDING, runFullValidation, buildCatalogPrompt, sanitize,\n' +
      '  sanitizeSpecStrings, videoMergeCatalog,\n' +
      '] as const;\n' +
      // Type witnesses — one alias per public type name (TS2305 on any drop).
      'export type _T = [\n' +
      '  MinituiActionDef, MinituiComponentDef, TrustTier, ActionKind, PermissionDescriptor,\n' +
      '  VisibilityClass, ActionBinding, AppSpec, SpecElement, ComponentDefinition,\n' +
      '  ActionDefinition, MinituiCatalog, AllowlistIssue, SemanticIssue, ValidationIssue,\n' +
      '  ValidationResult,\n' +
      '];\n' +
      // Force a couple of external re-export chains to resolve as VALUES.
      "export const _k: ActionKind = 'render-local';\n" +
      'export const _v: VisibilityClass = DEFAULT_VISIBILITY;\n',
  );
  // The runtime probe EXERCISES the shipped two-point gate on the real dist: the
  // generation-time allowlist bites an off-catalog component AND an unknown action
  // name, passes a fully on-catalog spec, and the render-time primitive throws loud.
  writeFileSync(
    join(tmp, 'run.mjs'),
    "import { rejectOffCatalog, throwingFallback, videoMergeCatalog } from '@minitui/catalog';\n" +
      "if (videoMergeCatalog.id !== 'video-merge') throw new Error('ESM import broken on shipped dist');\n" +
      '// A fully on-catalog spec passes the generation-time gate.\n' +
      'const legal = {\n' +
      "  root: 'app',\n" +
      '  elements: {\n' +
      "    app: { type: 'Button', props: { label: 'Go' }, on: { press: { action: 'merge' } } },\n" +
      '  },\n' +
      '};\n' +
      'if (rejectOffCatalog(legal, videoMergeCatalog).length !== 0)\n' +
      "  throw new Error('on-catalog spec wrongly rejected on shipped dist');\n" +
      '// An off-catalog COMPONENT is rejected (the no-arbitrary-code moat).\n' +
      "const badComp = { root: 'app', elements: { app: { type: 'IFrame', props: {} } } };\n" +
      'const compIssues = rejectOffCatalog(badComp, videoMergeCatalog);\n' +
      "if (!compIssues.some((i) => i.code === 'unknown-component'))\n" +
      "  throw new Error('off-catalog component NOT rejected on shipped dist');\n" +
      '// An off-catalog ACTION name is rejected (the net-new gate the core zod skips).\n' +
      'const badAction = {\n' +
      "  root: 'app',\n" +
      "  elements: { app: { type: 'Button', props: { label: 'X' }, on: { press: { action: 'exfiltrate' } } } },\n" +
      '};\n' +
      'const actIssues = rejectOffCatalog(badAction, videoMergeCatalog);\n' +
      "if (!actIssues.some((i) => i.code === 'unknown-action'))\n" +
      "  throw new Error('off-catalog action NOT rejected on shipped dist');\n" +
      '// The render-time primitive throws loud, naming the type — never a silent no-op.\n' +
      'let threw = false;\n' +
      "try { throwingFallback('IFrame'); } catch (e) { threw = /IFrame/.test(String(e)); }\n" +
      "if (!threw) throw new Error('throwingFallback did not throw naming the type on shipped dist');\n",
  );
  execFileSync('pnpm', ['install', '--offline'], { cwd: tmp, stdio: 'inherit' });
  // 5. Compile (declaration closure) + run the ESM probe. tsc comes from the repo
  // toolchain (catalog-pinned) run AGAINST the consumer project.
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
