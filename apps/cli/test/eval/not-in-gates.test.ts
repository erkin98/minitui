import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A paid run must never start from `pnpm test`, the pre-push hook or CI: no gate names the eval's script,
// its entry or its opt-in variable.

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const TOKENS = ['model-eval', 'eval/main.ts', 'MINITUI_EVAL_PAID'];
const tokensIn = (text: string): string[] => TOKENS.filter((token) => text.includes(token));

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const listed = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${dir}/${entry.name}`);

// The hook, every workflow, the root manifest's scripts, and every turbo.json of the workspace.
function gateTexts(): ReadonlyArray<readonly [string, string]> {
  const workflows = readdirSync(join(ROOT, '.github', 'workflows')).map(
    (file) => `.github/workflows/${file}`,
  );
  const turbo = ['.', 'test', ...listed('packages'), ...listed('apps')]
    .map((dir) => (dir === '.' ? 'turbo.json' : `${dir}/turbo.json`))
    .filter((path) => existsSync(join(ROOT, path)));
  const manifest: { readonly scripts?: Record<string, string> } = JSON.parse(read('package.json'));
  return [
    ...['lefthook.yml', ...workflows, ...turbo].map((path) => [path, read(path)] as const),
    ['package.json scripts', JSON.stringify(manifest.scripts ?? {})],
  ];
}

describe('the eval is in no gate', () => {
  it('no hook command, workflow, root script or turbo.json names its script, entry or opt-in', () => {
    const texts = gateTexts();
    const names = texts.map(([name]) => name);
    expect(names).toEqual(
      expect.arrayContaining([
        'lefthook.yml',
        '.github/workflows/ci.yml',
        'turbo.json',
        'test/turbo.json',
        'apps/cli/turbo.json',
        'package.json scripts',
      ]),
    );
    for (const name of ['lefthook.yml', '.github/workflows/ci.yml']) {
      expect(texts.find(([n]) => n === name)?.[1].length).toBeGreaterThan(0);
    }
    const hits = texts.flatMap(([name, text]) =>
      tokensIn(text).map((token) => `${name}: ${token}`),
    );
    expect(hits).toEqual([]);
  });

  it('the control: a workflow text holding each token is flagged by the same matcher', () => {
    for (const token of TOKENS) {
      const workflow = `jobs:\n  eval:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${token}\n`;
      expect(tokensIn(workflow)).toEqual([token]);
    }
  });
});
