import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export const TEST_DATABASE_URL = 'postgres://makeroom:makeroom@localhost:5432/makeroom_test';

export default defineConfig({
  test: {
    globalSetup: './test/global-setup.ts',
    // .env supplies the PayPal sandbox credentials; the sandbox test is skipped without them.
    env: { ...loadEnv('test', process.cwd(), ''), DATABASE_URL: TEST_DATABASE_URL },
  },
});
