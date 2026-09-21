import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // Loaded before every test module: installs firebase-admin/razorpay/dotenv
    // mocks and the global fetch stub (see tests/setup.ts).
    setupFiles: ['./tests/setup.ts'],
    // Each test file gets a fresh module registry so module-level caches
    // (plan cache, circuit breakers, model targets) never leak across files.
    isolate: true,
    testTimeout: 15000,
  },
});
