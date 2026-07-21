// Published-artifact gate: pack → assert tar (4 files) + manifest → install into a
// throwaway strict consumer → tsc (types:[] skipLibCheck:false) + one ESM import.
// Proves the SHIPPED tarball, not just source. Permanent (run by the package gate
// + the pre-publish CI lane), not review-only. §Z102.
/* global console, process, URL */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const nodeFloor = rootPkg.engines?.node;
const pkgMgr = rootPkg.packageManager;
const tmp = mkdtempSync(join(tmpdir(), 'minitui-types-pack-'));
try {
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
  // 2. Assert EXACTLY the four intended files (a stray/missing file reds).
  const files = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((p) => p.replace(/^package\//, ''))
    .sort();
  const want = ['dist/index.d.ts', 'dist/index.js', 'dist/index.js.map', 'package.json'];
  if (!eq(files, want)) die('packed files ' + JSON.stringify(files) + ' ≠ ' + JSON.stringify(want));
  // 3. Inspect the packed manifest: catalog: rewritten, engines present.
  const m = JSON.parse(
    execFileSync('tar', ['-xzOf', tgz, 'package/package.json'], { encoding: 'utf8' }),
  );
  if (!/^\d+\.\d+\.\d+/.test(m.dependencies?.zod ?? ''))
    die('zod not published concrete: ' + m.dependencies?.zod);
  // Engines floor checked by VALUE against the repo floor (not mere presence): a
  // weakened '*'/'>=18' or a dropped range reds instead of silently passing.
  if (m.engines?.node !== nodeFloor)
    die('packed engines.node ' + JSON.stringify(m.engines?.node) + ' ≠ repo floor ' + nodeFloor);
  // Exports map must ship both the types + import conditions — a deleted/half exports
  // map breaks every consumer's resolution yet would otherwise pass unchecked.
  if (!m.exports?.['.']?.types || !m.exports?.['.']?.import)
    die('packed manifest missing exports map: ' + JSON.stringify(m.exports));
  // 4. Install the tarball into a fresh strict consumer (pinned pnpm, not ambient).
  writeFileSync(
    join(tmp, 'package.json'),
    JSON.stringify({ name: 'c', private: true, type: 'module', packageManager: pkgMgr }),
  );
  writeFileSync(
    join(tmp, 'tsconfig.json'),
    JSON.stringify({
      // lib ES2023 (NO dom — mirrors the package's own tsconfig.base) so an ambient
      // Node global like AbortSignal CANNOT resolve from lib.dom; types:[] excludes
      // ambient @types/*. Without these two the gate is VACUOUS (§Z32): lib.dom would
      // supply AbortSignal and hide the closure gap.
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
  // types:[] + lib:[ES2023] + skipLibCheck:false forces a check of the WHOLE dist/index.d.ts
  // with no ambient fallback — an undeclared global (e.g. AbortSignal) reds TS2304 even
  // though probe imports only AppSpec.
  writeFileSync(
    join(tmp, 'probe.ts'),
    "import type { AppSpec } from '@minitui/types';\n" +
      "export const _s: AppSpec = { root: 'a', elements: { a: { type: 'Box', props: {} } } };\n",
  );
  writeFileSync(
    join(tmp, 'run.mjs'),
    "import { AppSpecSchema } from '@minitui/types';\n" +
      "if (typeof AppSpecSchema.parse !== 'function') { throw new Error('ESM import broken'); }\n",
  );
  execFileSync('pnpm', ['add', tgz], { cwd: tmp, stdio: 'inherit' });
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
