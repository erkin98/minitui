import { defineProject, mergeConfig } from 'vitest/config';
import sharedVitestConfig from '../../vitest.shared.js';

export default mergeConfig(
  sharedVitestConfig,
  defineProject({
    test: {
      name: '@minitui/sanitizer',
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  }),
);
