import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The capability walls hold in what ships, not only in the source: the built bundle of every package is
// scanned for the dependencies only one package may carry. Each family has a positive control on the one
// package that does carry it, so a scanner that matched nothing would fail. A missing build fails too.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const DIST: Readonly<Record<string, string>> = {
  types: 'packages/types/dist',
  transport: 'packages/transport/dist',
  sanitizer: 'packages/sanitizer/dist',
  'renderer-core': 'packages/renderer-core/dist',
  catalog: 'packages/catalog/dist',
  spec: 'packages/spec/dist',
  'agent-core': 'packages/agent-core/dist',
  exec: 'packages/exec/dist',
  'runtime-host': 'packages/runtime-host/dist',
  'renderer-ink': 'packages/renderer-ink/dist',
  cli: 'apps/cli/dist',
};
const PACKAGES = Object.keys(DIST);

const EXEC_ONLY = ['child_process', '@modelcontextprotocol/', '@anthropic-ai/sandbox-runtime'];
const MODEL_SDK = [/(["'`])ai(\/[^"'`]+)?\1/, /@ai-sdk\//];
const INK_FAMILY = [/(["'`])react\1/, /(["'`])ink\1/, /@json-render\/ink(?!\/server)/];

function readDist(pkg: string): string {
  const dir = join(repoRoot, DIST[pkg] ?? '');
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((file) => /\.(c|m)?js$/.test(file))
    .map((file) => readFileSync(join(dir, file), 'utf8'))
    .join('\n');
}

describe('shipped bundle leak gate', () => {
  it.each(PACKAGES)('%s has a built bundle to scan', (pkg) => {
    expect(readDist(pkg).length, `${DIST[pkg] ?? pkg} is missing: build first`).toBeGreaterThan(0);
  });

  it.each(PACKAGES.filter((pkg) => pkg !== 'exec'))(
    '%s carries no process, sandbox or tool-server client',
    (pkg) => {
      const bundle = readDist(pkg);
      for (const dep of EXEC_ONLY)
        expect(bundle.includes(dep), `${pkg} carries ${dep}`).toBe(false);
    },
  );

  it.each(PACKAGES.filter((pkg) => pkg !== 'agent-core'))('%s carries no model SDK', (pkg) => {
    const bundle = readDist(pkg);
    for (const pattern of MODEL_SDK) {
      expect(pattern.test(bundle), `${pkg} matches ${String(pattern)}`).toBe(false);
    }
  });

  it.each(PACKAGES.filter((pkg) => pkg !== 'renderer-ink' && pkg !== 'cli'))(
    '%s carries no React or Ink',
    (pkg) => {
      const bundle = readDist(pkg);
      for (const pattern of INK_FAMILY) {
        expect(pattern.test(bundle), `${pkg} matches ${String(pattern)}`).toBe(false);
      }
    },
  );

  it('the scan sees the process API and the sandbox runtime in exec', () => {
    const bundle = readDist('exec');
    expect(bundle.includes('child_process')).toBe(true);
    expect(bundle.includes('@anthropic-ai/sandbox-runtime')).toBe(true);
  });

  it('the scan sees the model SDK in agent-core', () => {
    const bundle = readDist('agent-core');
    expect(MODEL_SDK.some((pattern) => pattern.test(bundle))).toBe(true);
  });

  it('the scan sees React and Ink in renderer-ink', () => {
    const bundle = readDist('renderer-ink');
    expect(INK_FAMILY.some((pattern) => pattern.test(bundle))).toBe(true);
  });
});
