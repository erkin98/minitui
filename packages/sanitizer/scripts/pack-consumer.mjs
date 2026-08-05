// Published-artifact gate: pack → assert tar (3 files) + manifest → install into a
// throwaway strict consumer → tsc (types:[] skipLibCheck:false) + one ESM import.
// Proves the SHIPPED tarball, not just source. Permanent (run by the package gate
// + pre-push).
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
} from '../../../scripts/pack-contract.mjs';

// die() THROWS (never process.exit) so the finally-block temp-dir cleanup always runs —
// process.exit() skips finally and would leak the mkdtemp dir on every gate failure.
const die = (m) => {
  throw new Error(m);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pkgDir = fileURLToPath(new URL('..', import.meta.url));
// Repo root is the single source of truth for the Node floor + the pinned pnpm — read
// them (no second hardcoded copy) so the throwaway consumer install uses the repo's
// pinned pnpm, not an ambient one, and the packed engines floor is checked by value.
const rootPkg = JSON.parse(readFileSync(resolve(pkgDir, '..', '..', 'package.json'), 'utf8'));
assertRootToolchain(rootPkg, die);
const tmp = mkdtempSync(join(tmpdir(), 'minitui-sanitizer-pack-'));
try {
  assertConcreteSemverControl(die);
  // 1. Pack the built package to a temp dir (rewrites catalog: → concrete).
  const out = JSON.parse(
    execFileSync('pnpm', ['pack', '--pack-destination', tmp, '--json'], {
      cwd: pkgDir,
      encoding: 'utf8',
    }),
  );
  // pnpm 11 emits `filename` as an absolute path; resolve() handles both forms
  // (join() would double the tmp prefix on an absolute filename).
  const tgz = resolve(tmp, out.filename ?? die('pnpm pack emitted no filename'));
  // 2. Assert EXACTLY the three intended files (a stray/missing file reds).
  //    No sourcemap: this package's tsup config emits bundle + dts only.
  const files = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((p) => p.replace(/^package\//, ''))
    .sort();
  const want = ['dist/index.d.ts', 'dist/index.js', 'package.json'];
  if (!eq(files, want)) die('packed files ' + JSON.stringify(files) + ' ≠ ' + JSON.stringify(want));
  // 3. Inspect the packed manifest: catalog: rewritten, engines present, and the
  //    ONLY runtime dependency is @types/node (type declarations, zero runtime
  //    code; anything else would
  //    break the zero-runtime-dependency chokepoint invariant).
  const m = JSON.parse(
    execFileSync('tar', ['-xzOf', tgz, 'package/package.json'], { encoding: 'utf8' }),
  );
  const depNames = Object.keys(m.dependencies ?? {});
  if (!eq(depNames, ['@types/node']))
    die('runtime dependencies must be exactly [@types/node], got ' + JSON.stringify(depNames));
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
  // 4. Install the tarball into a fresh strict consumer (pinned pnpm, not ambient).
  writeFileSync(
    join(tmp, 'package.json'),
    JSON.stringify({
      name: 'c',
      private: true,
      type: 'module',
      packageManager: EXPECTED_PACKAGE_MANAGER,
    }),
  );
  writeFileSync(
    join(tmp, 'tsconfig.json'),
    JSON.stringify({
      // lib ES2023 (NO dom — mirrors the package's own tsconfig.base) so an ambient
      // web-stream global like TransformStream CANNOT resolve from lib.dom; types:[]
      // excludes ambient @types/*. Without these two the gate is vacuous:
      // lib.dom would supply TransformStream and hide the closure gap.
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
  // types:[] + lib:[ES2023] + skipLibCheck:false forces a check of the WHOLE
  // dist/index.d.ts with no ambient fallback — the undeclared TransformStream in
  // sanitizeStream's return type reds TS2304 unless the dts banner + published
  // @types/node dependency close the declaration graph.
  writeFileSync(
    join(tmp, 'probe.ts'),
    "import { sanitize, sanitizeStream, type SanitizeOptions } from '@minitui/sanitizer';\n" +
      "const opts: SanitizeOptions = { allow: 'none' };\n" +
      "export const cleaned: string = sanitize('x', opts);\n" +
      'export const stream: TransformStream<string, string> = sanitizeStream();\n',
  );
  writeFileSync(
    join(tmp, 'run.mjs'),
    "import { sanitize } from '@minitui/sanitizer';\n" +
      "if (sanitize('a\\u001b[31mb') !== 'ab') { throw new Error('ESM import broken'); }\n",
  );
  execFileSync('pnpm', ['add', '--offline', tgz], { cwd: tmp, stdio: 'inherit' });
  // 5. Compile (declaration closure) + run one ESM import. tsc comes from the
  // repo toolchain (catalog-pinned) run AGAINST the consumer project — the tmp
  // consumer has no typescript install of its own, and adding one here would
  // hardcode a version literal the catalog already owns. Module resolution is
  // rooted at the tmp tsconfig, so the closure check is unchanged.
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
