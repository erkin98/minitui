import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'transport',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
