// Published-artifact gate: pack → assert tar (4 files) + manifest → install into a
// throwaway strict consumer → tsc (types:[] skipLibCheck:false) + one ESM import that
// EXERCISES the untrusted-patch chokepoint. Proves the SHIPPED tarball, not just
// source. Transport is the first package with internal workspace deps, so the two
// leaf tarballs (@minitui/types, @minitui/sanitizer) are packed alongside and pinned
// via pnpm overrides — their 0.0.0 versions are not on any registry. Permanent (run
// by the package gate + the pre-publish CI lane), not review-only. §Z102.
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
const packagesDir = resolve(pkgDir, '..');
// Repo root is the single source of truth for the Node floor + the pinned pnpm — read
// them (no second hardcoded copy) so the throwaway consumer install uses the repo's
// pinned pnpm, not an ambient one, and the packed engines floor is checked by value.
const rootPkg = JSON.parse(readFileSync(resolve(packagesDir, '..', 'package.json'), 'utf8'));
const nodeFloor = rootPkg.engines?.node;
const pkgMgr = rootPkg.packageManager;
const tmp = mkdtempSync(join(tmpdir(), 'minitui-transport-pack-'));

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
  // 1. Pack transport + its two internal leaf deps (workspace: rewritten to concrete on pack).
  const tgz = pack(pkgDir);
  const typesTgz = pack(join(packagesDir, 'types'));
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
  if (!/^\d+\.\d+\.\d+/.test(m.dependencies?.rxjs ?? ''))
    die('rxjs not published concrete: ' + m.dependencies?.rxjs);
  if (!/^\d+\.\d+\.\d+/.test(m.dependencies?.['@minitui/types'] ?? ''))
    die('@minitui/types not rewritten concrete: ' + m.dependencies?.['@minitui/types']);
  // Engines floor checked by VALUE against the repo floor (not mere presence): a
  // weakened '*'/'>=18' or a dropped range reds instead of silently passing.
  if (m.engines?.node !== nodeFloor)
    die('packed engines.node ' + JSON.stringify(m.engines?.node) + ' ≠ repo floor ' + nodeFloor);
  // Exports map must ship both the types + import conditions — a deleted/half exports
  // map breaks every consumer's resolution yet would otherwise pass unchecked.
  if (!m.exports?.['.']?.types || !m.exports?.['.']?.import)
    die('packed manifest missing exports map: ' + JSON.stringify(m.exports));
  // 4. Install the tarballs into a fresh strict consumer. Overrides pin the two
  // internal deps to the local tarballs (0.0.0 resolves nowhere else). pnpm 11
  // reads overrides from pnpm-workspace.yaml, NOT the package.json `pnpm` key —
  // the latter is silently ignored and the install 404s on the registry
  // (empirically verified against pnpm 11.1/11.8).
  writeFileSync(
    join(tmp, 'package.json'),
    JSON.stringify({
      name: 'c',
      private: true,
      type: 'module',
      packageManager: pkgMgr,
      dependencies: { '@minitui/transport': 'file:' + tgz },
    }),
  );
  writeFileSync(
    join(tmp, 'pnpm-workspace.yaml'),
    'packages: []\n' +
      'overrides:\n' +
      "  '@minitui/types': file:" +
      typesTgz +
      '\n' +
      "  '@minitui/sanitizer': file:" +
      sanitizerTgz +
      '\n',
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
  // with no ambient fallback — an undeclared global (e.g. AbortSignal on RunHandle.signal)
  // reds TS2304 even though probe imports only type names.
  writeFileSync(
    join(tmp, 'probe.ts'),
    "import type { SeqVerdict, AppEvent } from '@minitui/transport';\n" +
      'export const _v: SeqVerdict = { ok: true };\n' +
      "export const _e: AppEvent = { kind: 'passthrough', rawType: 'X' };\n",
  );
  // The runtime probe EXERCISES the shipped chokepoint: fast-json-patch's CJS interop
  // (a lexer-invisible named import would crash right here) AND the __proto__-path
  // rejection on the real dist.
  writeFileSync(
    join(tmp, 'run.mjs'),
    "import { applyStatePatch, PatchError, createAppBus } from '@minitui/transport';\n" +
      "const next = applyStatePatch({}, [{ op: 'add', path: '/a', value: 1 }]);\n" +
      "if (next.a !== 1) throw new Error('applyStatePatch broken on shipped dist');\n" +
      'let threw = false;\n' +
      'try {\n' +
      "  applyStatePatch({}, [{ op: 'add', path: '/__proto__/polluted', value: true }]);\n" +
      '} catch (e) {\n' +
      "  if (!(e instanceof PatchError)) throw new Error('wrong error class: ' + e);\n" +
      '  threw = true;\n' +
      '}\n' +
      "if (!threw) throw new Error('__proto__ path NOT rejected on shipped dist');\n" +
      "if ({}.polluted !== undefined) throw new Error('Object.prototype polluted');\n" +
      "if (typeof createAppBus !== 'function') throw new Error('ESM import broken');\n",
  );
  execFileSync('pnpm', ['install'], { cwd: tmp, stdio: 'inherit' });
  // 5. Compile (declaration closure) + run the ESM probe. tsc comes from the
  // repo toolchain (catalog-pinned) run AGAINST the consumer project.
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
