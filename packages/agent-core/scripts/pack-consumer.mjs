// NOT YET WIRED into root `pack:check` — pending offline-metadata. The `--offline` install below fails
// with ERR_PNPM_NO_OFFLINE_META on `@ai-sdk/anthropic`/`ai`: their resolution metadata lands only in
// pnpm's `metadata-full-filtered/` cache, not the legacy `metadata/` mirror the offline resolver reads
// (unlike zod / @json-render, which resolve offline). `pnpm store add` primes the content store but not
// that mirror. Resolve the offline-metadata story (does a fresh-clone `pnpm install` populate
// `metadata/@ai-sdk`? if not, pin the SDK deps to packed tarballs like the workspace deps) before adding
// this to `pack:check`. See WHATS-LEFT. Structure below mirrors the spec pack-consumer.
//
// Published-artifact gate: pack agent-core (+ its one internal workspace dep @minitui/types) → assert
// tar (4 files) + manifest → install into a throwaway strict consumer with --offline → tsc (types:[],
// lib ES2023, skipLibCheck:true) forces the WHOLE dist/index.d.ts and its external re-exports to resolve
// → one ESM import that exercises the shipped runtime surface. Proves the tarball, not just source.
// External deps (ai, @ai-sdk/anthropic, zod) resolve from the offline store; @minitui/types (0.0.0, on no
// registry) is packed alongside and pinned via a pnpm override. Permanent (root pack:check + pre-push).
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
// Control first (pure + free): a broken checker fails in milliseconds instead of after a full pack.
assertRootToolchainControl(die);
assertRootToolchain(rootPkg, die);
const tmp = mkdtempSync(join(tmpdir(), 'minitui-agent-core-pack-'));

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

  // 1. Pack agent-core + its one internal workspace dep (workspace:* rewritten concrete on pack).
  const tgz = pack(pkgDir);
  const typesTgz = pack(join(packagesDir, 'types'));
  // 2. Assert EXACTLY the four intended files.
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
  assertConcreteDependencies(m.dependencies, 'packed manifest', die);
  if (m.engines?.node !== EXPECTED_NODE_FLOOR)
    die('packed engines.node ' + JSON.stringify(m.engines?.node) + ' != ' + EXPECTED_NODE_FLOOR);
  if (!m.exports?.['.']?.types || !m.exports?.['.']?.import)
    die('packed manifest missing exports map: ' + JSON.stringify(m.exports));
  if (!eq(Object.keys(m.exports ?? {}), ['.']))
    die('packed exports subpaths ' + JSON.stringify(Object.keys(m.exports ?? {})) + " ≠ ['.']");
  // 4. Install the tarballs into a fresh strict consumer. The override pins @minitui/types to its local
  // tarball (0.0.0 resolves nowhere else). ai / @ai-sdk/anthropic / zod resolve from the offline store.
  writeFileSync(
    join(tmp, 'package.json'),
    JSON.stringify({
      name: 'c',
      private: true,
      type: 'module',
      packageManager: EXPECTED_PACKAGE_MANAGER,
      dependencies: { '@minitui/agent-core': 'file:' + tgz },
    }),
  );
  writeFileSync(
    join(tmp, 'pnpm-workspace.yaml'),
    'packages: []\noverrides:\n  ' + "'@minitui/types': file:" + typesTgz + '\n',
  );
  writeFileSync(
    join(tmp, 'tsconfig.json'),
    JSON.stringify({
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
  // Surface-reachability probe: name every public value + type so a dropped barrel re-export reds TS2305
  // on the SHIPPED artifact (an export-RESOLUTION error, reported regardless of skipLibCheck).
  writeFileSync(
    join(tmp, 'probe.ts'),
    'import {\n' +
      '  AgentSession,\n' +
      '  createAiSdkProvider,\n' +
      '  createAnthropicModel,\n' +
      '  createMockProvider,\n' +
      '  createProviderRegistry,\n' +
      '  repeatedToolCallDetector,\n' +
      '  DEFAULT_STEP_CEILING,\n' +
      '  isTerminal,\n' +
      '  ProviderError,\n' +
      '  ContextOverflowError,\n' +
      '  RouteError,\n' +
      '  toRunError,\n' +
      '  redact,\n' +
      '  redactDeep,\n' +
      '  routeToolCallResult,\n' +
      '  routeObservation,\n' +
      '  summarizeExecEvents,\n' +
      '  createVisibilityChannel,\n' +
      '  createSpecSink,\n' +
      '  systemClock,\n' +
      "} from '@minitui/agent-core';\n" +
      'import type {\n' +
      '  AgentConfig,\n' +
      '  MinituiEvent,\n' +
      '  ModelProvider,\n' +
      '  ProviderChunk,\n' +
      '  ProviderRequest,\n' +
      '  ProviderMessage,\n' +
      '  ModelConfig,\n' +
      '  ProviderRegistry,\n' +
      '  ToolSchema,\n' +
      '  FinishReason,\n' +
      "} from '@minitui/agent-core';\n" +
      'export const _values = [\n' +
      '  AgentSession, createAiSdkProvider, createAnthropicModel, createMockProvider,\n' +
      '  createProviderRegistry, repeatedToolCallDetector, DEFAULT_STEP_CEILING, isTerminal,\n' +
      '  ProviderError, ContextOverflowError, RouteError, toRunError, redact, redactDeep,\n' +
      '  routeToolCallResult, routeObservation, summarizeExecEvents, createVisibilityChannel,\n' +
      '  createSpecSink, systemClock,\n' +
      '] as const;\n' +
      'export type _T = [\n' +
      '  AgentConfig, MinituiEvent, ModelProvider, ProviderChunk, ProviderRequest,\n' +
      '  ProviderMessage, ModelConfig, ProviderRegistry, ToolSchema, FinishReason,\n' +
      '];\n',
  );
  // Runtime probe: the shipped ESM dist loads and executes.
  writeFileSync(
    join(tmp, 'run.mjs'),
    "import { DEFAULT_STEP_CEILING, redact, systemClock, createProviderRegistry } from '@minitui/agent-core';\n" +
      'if (typeof DEFAULT_STEP_CEILING !== "number" || DEFAULT_STEP_CEILING <= 0)\n' +
      '  throw new Error("DEFAULT_STEP_CEILING broken on shipped dist");\n' +
      'if (redact("hello", undefined) !== "hello")\n' +
      '  throw new Error("redact broken on shipped dist");\n' +
      'if (typeof systemClock.now() !== "number")\n' +
      '  throw new Error("systemClock broken on shipped dist");\n' +
      'if (typeof createProviderRegistry !== "function")\n' +
      '  throw new Error("createProviderRegistry missing on shipped dist");\n',
  );
  execFileSync('pnpm', ['install', '--offline'], { cwd: tmp, stdio: 'inherit' });
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
