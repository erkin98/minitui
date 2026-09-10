import { defineProject, mergeConfig } from 'vitest/config';
import sharedVitestConfig from '../../vitest.shared.js';

export default mergeConfig(
  sharedVitestConfig,
  defineProject({
    test: {
      name: '@minitui/renderer-core',
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  }),
);
