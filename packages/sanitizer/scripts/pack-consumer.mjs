// Published-artifact gate: pack → assert tar (3 files) + manifest → install into a
// throwaway strict consumer → tsc (types:[] skipLibCheck:false) + one ESM import.
// Proves the SHIPPED tarball, not just source. Permanent (run by the package gate
// + the pre-publish CI lane), not review-only. §Z102.
/* global console, process, URL */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const die = (m) => {
  console.error('pack-consumer gate: ' + m);
  process.exit(1);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'minitui-sanitizer-pack-'));
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
  //    code — the §Z80-addendum declaration-closure dep; anything else would
  //    break the zero-runtime-dependency chokepoint invariant).
  const m = JSON.parse(
    execFileSync('tar', ['-xzOf', tgz, 'package/package.json'], { encoding: 'utf8' }),
  );
  const depNames = Object.keys(m.dependencies ?? {});
  if (!eq(depNames, ['@types/node']))
    die('runtime dependencies must be exactly [@types/node], got ' + JSON.stringify(depNames));
  if (!/^\d+\.\d+\.\d+/.test(m.dependencies?.['@types/node'] ?? ''))
    die('@types/node not published concrete: ' + m.dependencies?.['@types/node']);
  if (!m.engines?.node) die('packed manifest missing engines.node');
  // 4. Install the tarball into a fresh strict consumer.
  writeFileSync(
    join(tmp, 'package.json'),
    JSON.stringify({ name: 'c', private: true, type: 'module' }),
  );
  writeFileSync(
    join(tmp, 'tsconfig.json'),
    JSON.stringify({
      // lib ES2023 (NO dom — mirrors the package's own tsconfig.base) so an ambient
      // web-stream global like TransformStream CANNOT resolve from lib.dom; types:[]
      // excludes ambient @types/*. Without these two the gate is VACUOUS (§Z32):
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
  // @types/node dependency close the declaration graph (§Z80 addendum).
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
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
