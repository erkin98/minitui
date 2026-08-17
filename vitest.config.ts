// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { sharedVitestConfig } from './vitest.shared';

// Vitest 4: `test.projects` replaces the removed `defineWorkspace` / `vitest.workspace.ts`.
export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    projects: [
      // root determinism test as a proper inline project, sharing the determinism setup
      {
        test: {
          ...sharedVitestConfig.test,
          name: 'root',
          include: ['vitest.determinism.test.ts'],
        },
      },
      // The release-script + workflow tests live OUTSIDE every package (under scripts/ and
      // .github/), so no package glob reaches them — a dedicated inline project runs them under a
      // plain `vitest run` (`test:all`) and under `vitest run --project release-scripts` (the
      // release CI lane). Globs, not bare paths (a lone .test.ts is silently dropped). Empty
      // until those tests land — an inert no-op, zero matches.
      {
        test: {
          ...sharedVitestConfig.test,
          name: 'release-scripts',
          include: [
            'scripts/**/__tests__/**/*.test.ts',
            '.github/workflows/__tests__/**/*.test.ts',
          ],
        },
      },
      // glob project paths — each matches nothing until the package/test config lands, then
      // activates automatically; no package hand-adds itself.
      'packages/*/vitest.config.ts',
      // apps/cli's suite joins the aggregate via this glob —
      // inert until apps/cli lands, then activates automatically like the package glob.
      'apps/*/vitest.config.ts',
      // character-class glob for the SAME single path: a literal 'test/vitest.config.ts'
      // is not a glob to Vitest 4 and hard-errors while the file does not exist yet
      // (created later); the [t] makes it glob-magic, hence inert-until-present,
      // per this block's own globs-not-literals rule.
      '[t]est/vitest.config.ts',
    ],
  },
});
