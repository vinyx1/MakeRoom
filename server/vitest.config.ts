import { defineConfig } from 'vitest/config';

export const TEST_DATABASE_URL = 'postgres://rentflow:rentflow@localhost:5432/rentflow_test';

export default defineConfig({
  test: {
    globalSetup: './test/global-setup.ts',
    env: { DATABASE_URL: TEST_DATABASE_URL },
  },
});
