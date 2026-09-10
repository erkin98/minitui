// Published-artifact gate: pack → assert tar (4 files) + manifest → install into a
// throwaway strict consumer → tsc (types:[], lib ES2023, skipLibCheck:true) forces the
// WHOLE dist/index.d.ts AND its external re-exports to resolve → one ESM import that
// exercises the shipped validate surface. Proves the tarball, not just source. Spec has
// four internal workspace deps in its runtime closure — @minitui/catalog (and catalog's
// own types/renderer-core/sanitizer) — packed alongside and pinned via pnpm overrides;
// their 0.0.0 versions are on no registry. External deps (@json-render/core, zod, and
// catalog's ink/react/marked transitives) resolve from the offline store. Permanent (run
// by the root package gate + pre-push).
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
const tmp = mkdtempSync(join(tmpdir(), 'minitui-spec-pack-'));

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

  // 1. Pack spec + its four internal workspace deps (workspace:* rewritten concrete on pack).
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
  // Every dep (the internal workspace deps + @json-render/core + zod) MUST be a concrete
  // semver — a leaked workspace:* or a range reds here.
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
      dependencies: { '@minitui/spec': 'file:' + tgz },
    }),
  );
  // The four internal deps pin to the local tarballs. catalog's @json-render/ink transitive
  // hard-depends on react/ink/marked with RANGES; pin those three volatile transitives to
  // the versions the repo lockfile resolves — the only ones guaranteed in the offline store
  // — so the gate is deterministic and offline.
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
      // auto-included @types/*. skipLibCheck:true (like the catalog gate): spec's runtime
      // closure pulls @minitui/catalog, whose re-exports type-import `react` for render-fn
      // types a React-free package ships no @types/react for; skipLibCheck:false would
      // false-positive on that adopted, type-only import. The barrel-reachability check
      // below still bites (a dropped export is TS2305, reported regardless of skipLibCheck).
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
      '  createSpecStreamCompiler,\n' +
      '  compileSpecStream,\n' +
      '  ACTION_KINDS,\n' +
      '  ActionKindSchema,\n' +
      '  getByPath,\n' +
      '  collectBoundPointers,\n' +
      '  validateStructure,\n' +
      '  autoFixStructure,\n' +
      '  formatStructuralIssues,\n' +
      '  MAX_RETRIES,\n' +
      '  resolveBindings,\n' +
      '  checkCapabilities,\n' +
      '  checkFiles,\n' +
      '  checkVisibility,\n' +
      '  validateSemantics,\n' +
      '  toRuntimeRepair,\n' +
      '  buildValidationEnvelope,\n' +
      '  toRepromptText,\n' +
      '  composeValidation,\n' +
      '  toWireSpec,\n' +
      '  REPAIR_HEADER,\n' +
      '  SEMANTIC_HEADER,\n' +
      '  CATALOG_HEADER,\n' +
      '  formatSemanticIssues,\n' +
      '  formatCatalogIssues,\n' +
      "} from '@minitui/spec';\n" +
      'import type {\n' +
      '  Spec,\n' +
      '  UIElement,\n' +
      '  DynamicValue,\n' +
      '  MiniAppSpec,\n' +
      '  SpecMeta,\n' +
      '  ActionKind,\n' +
      '  BoundPointer,\n' +
      '  SpecIssue,\n' +
      '  CapabilityProvider,\n' +
      '  FileStat,\n' +
      '  SemanticIssue,\n' +
      '  SemanticResult,\n' +
      '  SemanticCode,\n' +
      '  RuntimeError,\n' +
      '  RuntimeRepair,\n' +
      '  ValidationEnvelope,\n' +
      "} from '@minitui/spec';\n" +
      // Force every value re-export to resolve (TS2305 on any drop) without executing.
      'export const _values = [\n' +
      '  createSpecStreamCompiler, compileSpecStream, ACTION_KINDS, ActionKindSchema,\n' +
      '  getByPath, collectBoundPointers, validateStructure, autoFixStructure,\n' +
      '  formatStructuralIssues, MAX_RETRIES, resolveBindings, checkCapabilities,\n' +
      '  checkFiles, checkVisibility, validateSemantics, toRuntimeRepair,\n' +
      '  buildValidationEnvelope, toRepromptText, composeValidation, toWireSpec,\n' +
      '  REPAIR_HEADER, SEMANTIC_HEADER, CATALOG_HEADER, formatSemanticIssues,\n' +
      '  formatCatalogIssues,\n' +
      '] as const;\n' +
      // Type witnesses — one alias per public type name (TS2305 on any drop).
      'export type _T = [\n' +
      '  Spec, UIElement, DynamicValue, MiniAppSpec, SpecMeta, ActionKind, BoundPointer,\n' +
      '  SpecIssue, CapabilityProvider, FileStat, SemanticIssue, SemanticResult,\n' +
      '  SemanticCode, RuntimeError, RuntimeRepair, ValidationEnvelope,\n' +
      '];\n' +
      // Force an external re-export chain to resolve as a VALUE.
      "export const _k: ActionKind = 'render-local';\n",
  );
  // The runtime probe proves the shipped ESM dist loads and executes: the canonical
  // action-kind tuple is intact, and a pure pointer read resolves an own-property path.
  writeFileSync(
    join(tmp, 'run.mjs'),
    "import { ACTION_KINDS, getByPath, formatStructuralIssues } from '@minitui/spec';\n" +
      'if (!Array.isArray(ACTION_KINDS) || ACTION_KINDS.length !== 4)\n' +
      "  throw new Error('ESM import broken on shipped dist (ACTION_KINDS)');\n" +
      "if (!ACTION_KINDS.includes('render-local'))\n" +
      "  throw new Error('ACTION_KINDS missing render-local on shipped dist');\n" +
      "if (getByPath({ a: { b: 42 } }, '/a/b') !== 42)\n" +
      "  throw new Error('getByPath broken on shipped dist');\n" +
      "if (getByPath({ a: 1 }, '/missing') !== undefined)\n" +
      "  throw new Error('getByPath resolved a missing own key on shipped dist');\n" +
      "if (formatStructuralIssues([]) !== '')\n" +
      "  throw new Error('formatStructuralIssues of [] not empty on shipped dist');\n",
  );
  execFileSync('pnpm', ['install', '--offline'], { cwd: tmp, stdio: 'inherit' });
  // 5. Compile (declaration closure) + run the ESM probe. tsc comes from the repo
  // toolchain (spec-pinned) run AGAINST the consumer project.
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
